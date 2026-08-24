// @effect-diagnostics globalDateInEffect:off globalTimers:off nodeBuiltinImport:off - Electron capture APIs and local queue operations run at the native Promise boundary.

import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingWindowCapture,
  WINDOW_CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS,
  type DesktopWindowCapture as DesktopWindowCaptureValue,
  type DesktopWindowCaptureState,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Electron from "electron";
import { activeWindow, type Result as ActiveWindow } from "get-windows";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  accessibleWindowText,
  findAccessibleWindow,
  findCaptureSource,
  isWaylandSession,
  shouldRequestScreenCapturePermission,
  toElectronAccelerator,
} from "./windowCapture.ts";

const MAX_CAPTURE_WIDTH = 5_120;
const MAX_CAPTURE_HEIGHT = 2_880;
const ACCESSIBLE_TEXT_TIMEOUT_MS = 1_000;
const CAPTURE_READY_ACTION = "window-capture-ready";
const CAPTURE_FAILED_ACTION = "window-capture-failed";
const MAC_SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE =
  "Allow Screen Recording in System Settings, then restart T3 Code.";

const decodePendingCapture = Schema.decodeUnknownSync(DesktopPendingWindowCapture);

const PendingCaptureJson = Schema.fromJsonString(DesktopPendingWindowCapture);
const decodePendingCaptureJson = Schema.decodeSync(PendingCaptureJson);
const encodePendingCaptureJson = Schema.encodeSync(PendingCaptureJson);
const DesktopWindowCaptureOperation = Schema.Literals(["list-pending", "read", "acknowledge"]);

export class DesktopWindowCaptureError extends Schema.TaggedErrorClass<DesktopWindowCaptureError>()(
  "DesktopWindowCaptureError",
  {
    operation: DesktopWindowCaptureOperation,
    captureId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "list-pending":
        return "Could not list pending window captures.";
      case "read":
        return "Could not read the window capture.";
      case "acknowledge":
        return "Could not remove the window capture.";
    }
  }
}

export class DesktopWindowCaptureUnsupportedError extends Schema.TaggedErrorClass<DesktopWindowCaptureUnsupportedError>()(
  "DesktopWindowCaptureUnsupportedError",
  { captureId: Schema.String },
) {
  override get message(): string {
    return "Window capture is not supported here.";
  }
}

export class DesktopWindowCaptureNoWindowSelectedError extends Schema.TaggedErrorClass<DesktopWindowCaptureNoWindowSelectedError>()(
  "DesktopWindowCaptureNoWindowSelectedError",
  { captureId: Schema.String },
) {
  override get message(): string {
    return "No window was selected.";
  }
}

export class DesktopWindowCaptureWindowUnavailableError extends Schema.TaggedErrorClass<DesktopWindowCaptureWindowUnavailableError>()(
  "DesktopWindowCaptureWindowUnavailableError",
  { captureId: Schema.String },
) {
  override get message(): string {
    return "The active window is not available for capture.";
  }
}

export class DesktopWindowCaptureFailedError extends Schema.TaggedErrorClass<DesktopWindowCaptureFailedError>()(
  "DesktopWindowCaptureFailedError",
  { captureId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not capture the active window.";
  }
}

export const DesktopWindowCaptureFailure = Schema.Union([
  DesktopWindowCaptureUnsupportedError,
  DesktopWindowCaptureNoWindowSelectedError,
  DesktopWindowCaptureWindowUnavailableError,
  DesktopWindowCaptureFailedError,
]);
export type DesktopWindowCaptureFailure = typeof DesktopWindowCaptureFailure.Type;
export const isDesktopWindowCaptureFailure = Schema.is(DesktopWindowCaptureFailure);

export class DesktopWindowCapture extends Context.Service<
  DesktopWindowCapture,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopWindowCaptureState>;
    readonly capture: Effect.Effect<void, DesktopWindowCaptureFailure>;
    readonly listPending: Effect.Effect<
      ReadonlyArray<DesktopPendingWindowCapture>,
      DesktopWindowCaptureError
    >;
    readonly read: (
      id: string,
    ) => Effect.Effect<DesktopWindowCaptureValue, DesktopWindowCaptureError>;
    readonly acknowledge: (id: string) => Effect.Effect<void, DesktopWindowCaptureError>;
  }
>()("@t3tools/desktop/windowCapture/DesktopWindowCapture") {}

function captureMode(platform: NodeJS.Platform): DesktopWindowCaptureState["mode"] {
  if (!["darwin", "linux", "win32"].includes(platform)) return "unavailable";
  return isWaylandSession(platform, process.env) ? "portal" : "direct";
}

function thumbnailSize(active: ActiveWindow | undefined): Electron.Size {
  if (!active) return { width: 2_560, height: 1_600 };
  return {
    width: Math.min(Math.max(active.bounds.width, 1), MAX_CAPTURE_WIDTH),
    height: Math.min(Math.max(active.bounds.height, 1), MAX_CAPTURE_HEIGHT),
  };
}

async function iconDataUrl(
  source: { readonly appIcon?: Electron.NativeImage | null },
  active: ActiveWindow | undefined,
): Promise<string | undefined> {
  try {
    const icon =
      source.appIcon && !source.appIcon.isEmpty()
        ? source.appIcon
        : active?.owner.path
          ? await Electron.app.getFileIcon(active.owner.path, { size: "small" })
          : undefined;
    return icon?.resize({ width: 32, height: 32, quality: "best" }).toDataURL();
  } catch {
    return undefined;
  }
}

async function requestMacScreenCapturePermission(): Promise<string | null> {
  let status: ReturnType<typeof Electron.systemPreferences.getMediaAccessStatus>;
  try {
    status = Electron.systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return null;
    if (status === "not-determined") {
      try {
        await Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
        });
      } catch {}
      status = Electron.systemPreferences.getMediaAccessStatus("screen");
      if (status === "granted") return null;
    }
  } catch {}
  await Electron.shell.openExternal(MAC_SCREEN_CAPTURE_SETTINGS_URL).catch(() => undefined);
  return MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
}

async function requestMacWindowCapturePermissions(): Promise<string | null> {
  const accessibilityGranted = Electron.systemPreferences.isTrustedAccessibilityClient(true);
  const screenMessage = await requestMacScreenCapturePermission();
  if (!accessibilityGranted && screenMessage) {
    return "Allow Accessibility and Screen Recording in System Settings, then restart T3 Code.";
  }
  if (!accessibilityGranted) {
    return "Allow Accessibility in System Settings, then restart T3 Code.";
  }
  return screenMessage;
}

async function readCapturedWindowText(
  active: ActiveWindow,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const { App } = await import("@crowecawcaw/xa11y");
  const windows =
    platform === "win32"
      ? (await App.list())
          .filter((app) => app.pid === active.owner.processId)
          .map((app) => app.asElement())
      : await (await App.byPid(active.owner.processId, { timeout: 0 })).children();
  const window = findAccessibleWindow(windows, active);
  if (!window) return undefined;
  const text = accessibleWindowText(await window.tree(), WINDOW_CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS);
  return text || undefined;
}

async function readAccessibleWindowText(
  active: ActiveWindow,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      readCapturedWindowText(active, platform),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(resolve, ACCESSIBLE_TEXT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function revealPreviousWindowIfNeeded(): Promise<Electron.BrowserWindow | undefined> {
  const focused = Electron.BrowserWindow.getFocusedWindow();
  if (!focused) return undefined;
  focused.hide();
  await new Promise((resolve) => setTimeout(resolve, 120));
  return focused;
}

async function captureSource(
  mode: DesktopWindowCaptureState["mode"],
  captureId: string,
  platform: NodeJS.Platform,
) {
  let active: ActiveWindow | undefined;
  const hiddenWindow = await revealPreviousWindowIfNeeded();

  try {
    if (mode === "direct") {
      active = await activeWindow({
        accessibilityPermission: false,
        screenRecordingPermission: false,
      });
    }

    const sources = await Electron.desktopCapturer.getSources({
      types: mode === "portal" ? ["window", "screen"] : ["window"],
      thumbnailSize: thumbnailSize(active),
      fetchWindowIcons: true,
    });
    const source =
      mode === "portal" ? sources[0] : active ? findCaptureSource(sources, active) : undefined;
    if (!source || source.thumbnail.isEmpty()) {
      throw mode === "portal"
        ? new DesktopWindowCaptureNoWindowSelectedError({ captureId })
        : new DesktopWindowCaptureWindowUnavailableError({ captureId });
    }
    const accessibleText = active ? await readAccessibleWindowText(active, platform) : undefined;
    return { source, active, accessibleText };
  } finally {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.show();
  }
}

function showFlash(settings: ClientSettings, active: ActiveWindow | undefined): void {
  if (!settings.windowCaptureFlash) return;
  const displayBounds = active
    ? active.bounds
    : Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).bounds;
  const flash = new Electron.BrowserWindow({
    ...displayBounds,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
  });
  flash.setIgnoreMouseEvents(true);
  const duration = settings.windowCaptureAnimations ? 180 : 70;
  const animation = settings.windowCaptureAnimations ? "animation:flash 180ms ease-out both" : "";
  const html =
    '<!doctype html><style>@keyframes flash{0%{opacity:0}20%{opacity:1}100%{opacity:0}}</style><body style="margin:0;background:rgba(255,255,255,.72);' +
    animation +
    '"></body>';
  void flash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    if (flash.isDestroyed()) return;
    flash.showInactive();
    setTimeout(() => {
      if (!flash.isDestroyed()) flash.close();
    }, duration);
  });
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const settingsRef = yield* Ref.make(DEFAULT_CLIENT_SETTINGS);
  const stateRef = yield* Ref.make<DesktopWindowCaptureState>({
    mode: captureMode(environment.platform),
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    message: null,
  });
  const busyRef = yield* Ref.make(false);
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow
  >();
  const runPromise = Effect.runPromiseWith(context);
  const captureDirectory = NodePath.join(environment.stateDir, "window-captures");
  let registeredAccelerator: string | undefined;

  const setFailure = (message: string) =>
    Ref.update(stateRef, (state) => ({ ...state, message })).pipe(
      Effect.andThen(
        desktopWindow
          .dispatchMenuAction(CAPTURE_FAILED_ACTION)
          .pipe(Effect.catch(() => Effect.void)),
      ),
    );

  const persistCapture = (settings: ClientSettings) => {
    const id = NodeCrypto.randomUUID();
    return Effect.tryPromise({
      try: async () => {
        const mode = captureMode(environment.platform);
        if (mode === "unavailable") {
          throw new DesktopWindowCaptureUnsupportedError({ captureId: id });
        }
        const imagePath = NodePath.join(captureDirectory, `${id}.png`);
        const imageTempPath = NodePath.join(captureDirectory, `${id}.tmp.png`);
        const metadataPath = NodePath.join(captureDirectory, `${id}.json`);
        await NodeFSP.mkdir(captureDirectory, { recursive: true });
        try {
          const { source, active, accessibleText } = await captureSource(
            mode,
            id,
            environment.platform,
          );
          const png = source.thumbnail.toPNG();
          const capturedAt = new Date().toISOString();
          const appIconDataUrl = await iconDataUrl(source, active);
          const pending = decodePendingCapture({
            id,
            name: `window-${capturedAt.replaceAll(":", "-")}.png`,
            mimeType: "image/png",
            sizeBytes: png.byteLength,
            source: {
              kind: "window-capture",
              capturedAt,
              appName: active?.owner.name.trim() || source.name.trim() || "Window",
              windowTitle: active?.title.trim() || source.name.trim(),
              ...(accessibleText ? { accessibleText } : {}),
              ...(active?.platform === "macos" && active.owner.bundleId
                ? { appIdentifier: active.owner.bundleId }
                : {}),
              ...(appIconDataUrl ? { appIconDataUrl } : {}),
            },
          });
          await NodeFSP.writeFile(imageTempPath, png);
          await NodeFSP.rename(imageTempPath, imagePath);
          await NodeFSP.writeFile(metadataPath + ".tmp", encodePendingCaptureJson(pending), "utf8");
          await NodeFSP.rename(metadataPath + ".tmp", metadataPath);
          showFlash(settings, active);
        } catch (cause) {
          await Promise.allSettled([
            NodeFSP.rm(imagePath, { force: true }),
            NodeFSP.rm(imageTempPath, { force: true }),
            NodeFSP.rm(metadataPath, { force: true }),
            NodeFSP.rm(metadataPath + ".tmp", { force: true }),
          ]);
          throw cause;
        }
      },
      catch: (cause) =>
        isDesktopWindowCaptureFailure(cause)
          ? cause
          : new DesktopWindowCaptureFailedError({ captureId: id, cause }),
    });
  };

  const capture = Effect.gen(function* () {
    if (yield* Ref.getAndSet(busyRef, true)) return;
    const settings = yield* Ref.get(settingsRef);
    yield* persistCapture(settings).pipe(
      Effect.tap(() =>
        Ref.update(stateRef, (state) => ({ ...state, message: null })).pipe(
          Effect.andThen(
            desktopWindow
              .dispatchMenuAction(CAPTURE_READY_ACTION)
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      ),
      Effect.tapError((error) => setFailure(error.message)),
      Effect.ensuring(Ref.set(busyRef, false)),
    );
  }).pipe(Effect.withSpan("desktop.windowCapture.capture"));

  const configure = Effect.fn("desktop.windowCapture.configure")(function* (
    settings: ClientSettings,
  ) {
    const previousSettings = yield* Ref.get(settingsRef);
    yield* Ref.set(settingsRef, settings);
    const permissionMessage = shouldRequestScreenCapturePermission(
      environment.platform,
      previousSettings.windowCaptureEnabled,
      settings.windowCaptureEnabled,
    )
      ? yield* Effect.promise(requestMacWindowCapturePermissions)
      : null;
    if (registeredAccelerator) {
      Electron.globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = undefined;
    }

    const mode = captureMode(environment.platform);
    if (!settings.windowCaptureEnabled || mode === "unavailable") {
      yield* Ref.set(stateRef, {
        mode,
        shortcut: settings.windowCaptureShortcut,
        shortcutRegistered: false,
        message:
          mode === "unavailable" ? "Window capture is not supported on this platform." : null,
      });
      return;
    }

    const accelerator = toElectronAccelerator(settings.windowCaptureShortcut);
    const registered = Electron.globalShortcut.register(accelerator, () => {
      void runPromise(capture).catch(() => undefined);
    });
    if (registered) registeredAccelerator = accelerator;
    yield* Ref.set(stateRef, {
      mode,
      shortcut: settings.windowCaptureShortcut,
      shortcutRegistered: registered,
      message:
        permissionMessage ?? (registered ? null : "This shortcut is already used by another app."),
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (registeredAccelerator) Electron.globalShortcut.unregister(registeredAccelerator);
    }),
  );

  return DesktopWindowCapture.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
      ),
    ),
    configure,
    state: Ref.get(stateRef),
    capture,
    listPending: Effect.tryPromise({
      try: async () => {
        const names = await NodeFSP.readdir(captureDirectory).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        const captures = (
          await Promise.all(
            names
              .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
              .map(async (name) => {
                try {
                  return decodePendingCaptureJson(
                    await NodeFSP.readFile(NodePath.join(captureDirectory, name), "utf8"),
                  );
                } catch {
                  return undefined;
                }
              }),
          )
        ).filter((capture) => capture !== undefined);
        return captures.sort((left, right) =>
          left.source.capturedAt.localeCompare(right.source.capturedAt),
        );
      },
      catch: (cause) => new DesktopWindowCaptureError({ operation: "list-pending", cause }),
    }),
    read: (id) =>
      Effect.tryPromise({
        try: async () => {
          const metadata = decodePendingCaptureJson(
            await NodeFSP.readFile(NodePath.join(captureDirectory, `${id}.json`), "utf8"),
          );
          const png = await NodeFSP.readFile(NodePath.join(captureDirectory, `${id}.png`));
          return {
            ...metadata,
            dataUrl: `data:image/png;base64,${png.toString("base64")}`,
          };
        },
        catch: (cause) =>
          new DesktopWindowCaptureError({ operation: "read", captureId: id, cause }),
      }),
    acknowledge: (id) =>
      Effect.tryPromise({
        try: async () => {
          await Promise.all([
            NodeFSP.rm(NodePath.join(captureDirectory, `${id}.json`), { force: true }),
            NodeFSP.rm(NodePath.join(captureDirectory, `${id}.png`), { force: true }),
          ]);
        },
        catch: (cause) =>
          new DesktopWindowCaptureError({ operation: "acknowledge", captureId: id, cause }),
      }),
  });
});

export const layer = Layer.effect(DesktopWindowCapture, make);
