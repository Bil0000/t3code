// @effect-diagnostics globalDateInEffect:off globalTimers:off

import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingWindowCapture,
  WINDOW_CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS,
  type DesktopWindowCapture as DesktopWindowCaptureValue,
  type DesktopWindowCaptureShortcutAvailability,
  type DesktopWindowCaptureState,
  type ClientSettings,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";
import { activeWindow, type Result as ActiveWindow } from "get-windows";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";
import {
  accessibleWindowText,
  effectiveWindowCaptureShortcut,
  findAccessibleWindow,
  findCaptureSource,
  hideAndWaitForBlur,
  isBothShiftKeysShortcut,
  isWaylandSession,
  shouldRequestScreenCapturePermission,
  toElectronAccelerator,
  windowCaptureShortcutRegistrationFailureMessage,
  windowCaptureShortcutSystemConflict,
} from "./windowCapture.ts";

const MAX_CAPTURE_WIDTH = 5_120;
const MAX_CAPTURE_HEIGHT = 2_880;
const ACCESSIBLE_TEXT_TIMEOUT_MS = 1_000;
const CAPTURE_READY_ACTION = "window-capture-ready";
const CAPTURE_FAILED_ACTION = "window-capture-failed";
const FLASH_ANIMATION_DURATION_MS = 180;
const FLASH_STATIC_DURATION_MS = 60;
const WINDOW_CAPTURE_FLASH_HTML = [
  "<!doctype html>",
  "<style>",
  "html,body{width:100%;height:100%}",
  "body{margin:0;opacity:0;background:rgba(255,255,255,.18);will-change:opacity}",
  "body.animate{animation:flash 180ms cubic-bezier(.2,.8,.2,1) both}",
  "body.still{opacity:1}",
  "@keyframes flash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}",
  "</style><body></body>",
  '<script>window.playFlash=(className)=>{document.body.className="";void document.body.offsetWidth;if(className==="animate"){requestAnimationFrame(()=>{document.body.className=className});return}document.body.className=className}</script>',
].join("");
const WINDOW_CAPTURE_FLASH_URL =
  "data:text/html;charset=utf-8," + encodeURIComponent(WINDOW_CAPTURE_FLASH_HTML);
const MAC_SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE =
  "Allow Screen Recording in System Settings, then restart T3 Code.";

const decodePendingCapture = Schema.decodeUnknownEffect(DesktopPendingWindowCapture);

const PendingCaptureJson = Schema.fromJsonString(DesktopPendingWindowCapture);
const decodePendingCaptureJson = Schema.decodeEffect(PendingCaptureJson);
const encodePendingCaptureJson = Schema.encodeEffect(PendingCaptureJson);
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

export class DesktopWindowCaptureDisabledError extends Schema.TaggedErrorClass<DesktopWindowCaptureDisabledError>()(
  "DesktopWindowCaptureDisabledError",
  {},
) {
  override get message(): string {
    return "Enable Window Capture in Settings first.";
  }
}

export class DesktopWindowCaptureUnauthorizedError extends Schema.TaggedErrorClass<DesktopWindowCaptureUnauthorizedError>()(
  "DesktopWindowCaptureUnauthorizedError",
  {},
) {
  override get message(): string {
    return "Window capture request was rejected.";
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
  { captureId: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not capture the active window.";
  }
}

export const DesktopWindowCaptureFailure = Schema.Union([
  DesktopWindowCaptureUnsupportedError,
  DesktopWindowCaptureDisabledError,
  DesktopWindowCaptureUnauthorizedError,
  DesktopWindowCaptureNoWindowSelectedError,
  DesktopWindowCaptureWindowUnavailableError,
  DesktopWindowCaptureFailedError,
]);
export type DesktopWindowCaptureFailure = typeof DesktopWindowCaptureFailure.Type;
export const isDesktopWindowCaptureFailure = Schema.is(DesktopWindowCaptureFailure);

function captureFailure(cause: unknown, captureId?: string): DesktopWindowCaptureFailure {
  return isDesktopWindowCaptureFailure(cause)
    ? cause
    : new DesktopWindowCaptureFailedError({ captureId, cause });
}

export class DesktopWindowCapture extends Context.Service<
  DesktopWindowCapture,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopWindowCaptureState>;
    readonly checkShortcut: (
      shortcut: WindowCaptureShortcut,
    ) => Effect.Effect<DesktopWindowCaptureShortcutAvailability>;
    readonly capture: Effect.Effect<void, DesktopWindowCaptureFailure>;
    readonly captureNow: Effect.Effect<void, DesktopWindowCaptureFailure>;
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

export function windowCaptureIconDataUrl(
  capturedIcon: Electron.NativeImage | null | undefined,
  fileIcon: Electron.NativeImage | null | undefined,
): string | undefined {
  const icon = fileIcon && !fileIcon.isEmpty() ? fileIcon : capturedIcon;
  if (!icon || icon.isEmpty()) return undefined;
  return icon.resize({ width: 32, height: 32, quality: "best" }).toDataURL({ scaleFactor: 2 });
}

async function iconDataUrl(
  source: { readonly appIcon?: Electron.NativeImage | null },
  active: ActiveWindow | undefined,
): Promise<string | undefined> {
  try {
    const fileIcon = active?.owner.path
      ? await Electron.app.getFileIcon(active.owner.path, { size: "large" }).catch(() => undefined)
      : undefined;
    return windowCaptureIconDataUrl(source.appIcon, fileIcon);
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

function currentMacWindowCapturePermissionMessage(): string | null {
  const accessibilityGranted = Electron.systemPreferences.isTrustedAccessibilityClient(false);
  const screenGranted = Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
  if (!accessibilityGranted && !screenGranted) {
    return "Allow Accessibility and Screen Recording in System Settings, then restart T3 Code.";
  }
  if (!accessibilityGranted) {
    return "Allow Accessibility in System Settings, then restart T3 Code.";
  }
  return screenGranted ? null : MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
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
  sourceTitle: string,
): Promise<string | undefined> {
  const { App } = await import("@crowecawcaw/xa11y");
  const windows =
    platform === "win32"
      ? (await App.list())
          .filter((app) => app.pid === active.owner.processId)
          .map((app) => app.asElement())
      : await (await App.byPid(active.owner.processId, { timeout: 0 })).children();
  const window = findAccessibleWindow(windows, {
    title: active.title,
    sourceTitle,
    bounds: active.bounds,
  });
  if (!window) return undefined;
  const text = accessibleWindowText(await window.tree(), WINDOW_CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS);
  return text || undefined;
}

async function readAccessibleWindowText(
  active: ActiveWindow,
  platform: NodeJS.Platform,
  sourceTitle: string,
): Promise<string | undefined> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      readCapturedWindowText(active, platform, sourceTitle),
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

async function captureSource({
  mode,
  captureId,
  platform,
  settings,
  flash,
}: {
  mode: DesktopWindowCaptureState["mode"];
  captureId: string;
  platform: NodeJS.Platform;
  settings: ClientSettings;
  flash: WindowCaptureFlash;
}) {
  let active: ActiveWindow | undefined;
  const hiddenWindow = Electron.BrowserWindow.getFocusedWindow();
  if (settings.windowCaptureFlash) void flash.prepare().catch(() => undefined);

  try {
    if (hiddenWindow) await hideAndWaitForBlur(hiddenWindow);
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
    showFlash(flash, settings, active);
    const accessibleText = active
      ? await readAccessibleWindowText(active, platform, source.name)
      : undefined;
    return { source, active, accessibleText };
  } finally {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.show();
  }
}

function createWindowCaptureFlashWindow(): Electron.BrowserWindow {
  const window = new Electron.BrowserWindow({
    width: 1,
    height: 1,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
  });
  window.setIgnoreMouseEvents(true);
  return window;
}

export class WindowCaptureFlash {
  private flashWindow: Electron.BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  prepare(): Promise<void> {
    if (this.flashWindow && !this.flashWindow.isDestroyed() && this.ready) return this.ready;
    const window = createWindowCaptureFlashWindow();
    this.flashWindow = window;
    this.ready = window.loadURL(WINDOW_CAPTURE_FLASH_URL).catch((error) => {
      if (this.flashWindow === window) this.dispose();
      throw error;
    });
    return this.ready;
  }

  showAnimated(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, "animate", FLASH_ANIMATION_DURATION_MS);
  }

  showStatic(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, "still", FLASH_STATIC_DURATION_MS);
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.flashWindow && !this.flashWindow.isDestroyed()) this.flashWindow.destroy();
    this.flashWindow = undefined;
    this.ready = undefined;
  }

  private async show(
    bounds: Electron.Rectangle,
    className: "animate" | "still",
    durationMs: number,
  ): Promise<void> {
    await this.prepare();
    const window = this.flashWindow;
    if (!window || window.isDestroyed()) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    window.setBounds(bounds);
    await window.webContents.executeJavaScript(
      "window.playFlash(" + JSON.stringify(className) + ")",
    );
    if (window.isDestroyed()) return;
    window.showInactive();
    this.hideTimer = setTimeout(() => {
      if (!window.isDestroyed()) window.hide();
    }, durationMs);
  }
}

function showFlash(
  flash: WindowCaptureFlash,
  settings: ClientSettings,
  active: ActiveWindow | undefined,
): void {
  if (!settings.windowCaptureFlash) return;
  const bounds = active
    ? active.bounds
    : Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).bounds;
  const playback = settings.windowCaptureAnimations
    ? flash.showAnimated(bounds)
    : flash.showStatic(bounds);
  void playback.catch(() => undefined);
}

function probeGlobalShortcut(accelerator: string): DesktopWindowCaptureShortcutAvailability {
  try {
    if (!Electron.globalShortcut.register(accelerator, () => undefined)) {
      return {
        available: false,
        message: "This shortcut is already used by the system or another app.",
      };
    }
    Electron.globalShortcut.unregister(accelerator);
    return { available: true, message: null };
  } catch {
    return { available: false, message: "The system could not register this shortcut." };
  }
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settingsRef = yield* Ref.make(DEFAULT_CLIENT_SETTINGS);
  const stateRef = yield* Ref.make<DesktopWindowCaptureState>({
    mode: captureMode(environment.platform),
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    message: null,
  });
  const busyRef = yield* Ref.make(false);
  const configurationMutex = yield* Semaphore.make(1);
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow
  >();
  const runPromise = Effect.runPromiseWith(context);
  const captureDirectory = path.join(environment.stateDir, "window-captures");
  let registeredAccelerator: string | undefined;
  let stopShiftShortcut: (() => void) | undefined;
  const flash = new WindowCaptureFlash();

  const releaseShortcut = () => {
    if (registeredAccelerator) {
      Electron.globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = undefined;
    }
    stopShiftShortcut?.();
    stopShiftShortcut = undefined;
  };

  const setFailure = (message: string) =>
    Ref.update(stateRef, (state) => ({ ...state, message })).pipe(
      Effect.andThen(
        desktopWindow
          .dispatchMenuAction(CAPTURE_FAILED_ACTION)
          .pipe(Effect.catch(() => Effect.void)),
      ),
    );

  const persistCapture = Effect.fn("desktop.windowCapture.persistCapture")(function* (
    settings: ClientSettings,
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => captureFailure(cause)));
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return yield* new DesktopWindowCaptureUnsupportedError({ captureId: id });
    }
    const imagePath = path.join(captureDirectory, `${id}.png`);
    const imageTempPath = path.join(captureDirectory, `${id}.tmp.png`);
    const metadataPath = path.join(captureDirectory, `${id}.json`);
    const cleanup = Effect.all(
      [imagePath, imageTempPath, metadataPath, metadataPath + ".tmp"].map((filePath) =>
        fileSystem.remove(filePath, { force: true }),
      ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(captureDirectory, { recursive: true });
      const { source, active, accessibleText } = yield* Effect.tryPromise({
        try: () =>
          captureSource({ mode, captureId: id, platform: environment.platform, settings, flash }),
        catch: (cause) => captureFailure(cause, id),
      });
      const png = yield* Effect.try({
        try: () => source.thumbnail.toPNG(),
        catch: (cause) => captureFailure(cause, id),
      });
      const capturedAt = new Date().toISOString();
      const appIconDataUrl = yield* Effect.promise(() => iconDataUrl(source, active));
      const pending = yield* decodePendingCapture({
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
      yield* fileSystem.writeFile(imageTempPath, png);
      yield* fileSystem.rename(imageTempPath, imagePath);
      yield* fileSystem.writeFileString(
        metadataPath + ".tmp",
        yield* encodePendingCaptureJson(pending),
      );
      yield* fileSystem.rename(metadataPath + ".tmp", metadataPath);
    }).pipe(
      Effect.mapError((cause) => captureFailure(cause, id)),
      Effect.tapError(() => cleanup),
    );
  });

  const captureNow = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    if (yield* Ref.getAndSet(busyRef, true)) return;
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

  const capture = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    if (!settings.windowCaptureEnabled) {
      return yield* new DesktopWindowCaptureDisabledError();
    }
    yield* captureNow;
  });

  const checkShortcut = Effect.fn("desktop.windowCapture.checkShortcut")(function* (
    shortcut: WindowCaptureShortcut,
  ) {
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return { available: false, message: "Window capture is not supported on this platform." };
    }
    if (mode === "portal") {
      return {
        available: true,
        message: isBothShiftKeysShortcut(shortcut)
          ? "Wayland uses Ctrl+Shift+2 because it does not expose physical modifier pairs."
          : "Your desktop will confirm this shortcut when you enable Window Capture.",
      };
    }
    if (isBothShiftKeysShortcut(shortcut)) {
      const available = yield* Effect.tryPromise(() => import("uiohook-napi")).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return {
        available,
        message: available
          ? "Shift + Shift is observed and cannot be reserved exclusively."
          : windowCaptureShortcutRegistrationFailureMessage(shortcut),
      };
    }
    const systemConflict = windowCaptureShortcutSystemConflict(shortcut);
    if (systemConflict) return { available: false, message: systemConflict };
    const accelerator = toElectronAccelerator(shortcut);
    if (registeredAccelerator === accelerator) return { available: true, message: null };
    return probeGlobalShortcut(accelerator);
  });

  const applySettings = Effect.fn("desktop.windowCapture.applySettings")(function* (
    settings: ClientSettings,
    requestedPermissionMessage: string | null,
  ) {
    yield* Ref.set(settingsRef, settings);
    releaseShortcut();

    const mode = captureMode(environment.platform);
    const shortcut = effectiveWindowCaptureShortcut(mode, settings.windowCaptureShortcut);
    if (!settings.windowCaptureEnabled || !settings.windowCaptureFlash || mode === "unavailable") {
      flash.dispose();
    }
    if (!settings.windowCaptureEnabled || mode === "unavailable") {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        message:
          mode === "unavailable" ? "Window capture is not supported on this platform." : null,
      });
      return;
    }

    const permissionMessage =
      requestedPermissionMessage ??
      (environment.platform === "darwin" ? currentMacWindowCapturePermissionMessage() : null);
    if (permissionMessage) {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        message: permissionMessage,
      });
      return;
    }

    let registered = false;
    if (isBothShiftKeysShortcut(shortcut)) {
      registered = yield* Effect.tryPromise(async () => {
        const { uIOhook } = await import("uiohook-napi");
        stopShiftShortcut = startGlobalShiftShortcut(uIOhook, () => {
          void runPromise(capture).catch(() => undefined);
        });
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    } else {
      const accelerator = toElectronAccelerator(shortcut);
      registered = Electron.globalShortcut.register(accelerator, () => {
        void runPromise(capture).catch(() => undefined);
      });
      if (registered) registeredAccelerator = accelerator;
    }

    yield* Ref.set(stateRef, {
      mode,
      shortcut,
      shortcutRegistered: registered,
      message: registered
        ? mode === "portal" && isBothShiftKeysShortcut(settings.windowCaptureShortcut)
          ? "Wayland uses Ctrl+Shift+2 because it does not expose physical modifier pairs."
          : isBothShiftKeysShortcut(shortcut)
            ? "Shift + Shift is observed and cannot be reserved exclusively."
            : null
        : windowCaptureShortcutRegistrationFailureMessage(shortcut),
    });
  });

  const configure = Effect.fn("desktop.windowCapture.configure")(function* (
    settings: ClientSettings,
  ) {
    yield* configurationMutex.withPermits(1)(
      Effect.gen(function* () {
        const previousSettings = yield* Ref.get(settingsRef);
        const permissionMessage = shouldRequestScreenCapturePermission(
          environment.platform,
          previousSettings.windowCaptureEnabled,
          settings.windowCaptureEnabled,
        )
          ? yield* Effect.promise(requestMacWindowCapturePermissions)
          : null;
        yield* applySettings(settings, permissionMessage);
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseShortcut();
      flash.dispose();
    }),
  );

  return DesktopWindowCapture.of({
    initialize: configurationMutex.withPermits(1)(
      clientSettings.get.pipe(
        Effect.flatMap((stored) =>
          applySettings(
            Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS),
            null,
          ),
        ),
      ),
    ),
    configure,
    state: Ref.get(stateRef),
    checkShortcut,
    capture,
    captureNow,
    listPending: fileSystem.readDirectory(captureDirectory).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(cause),
      }),
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp")),
          (name) =>
            fileSystem.readFileString(path.join(captureDirectory, name)).pipe(
              Effect.flatMap(decodePendingCaptureJson),
              Effect.orElseSucceed(() => undefined),
            ),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((captures) =>
        captures
          .filter((capture) => capture !== undefined)
          .sort((left, right) => left.source.capturedAt.localeCompare(right.source.capturedAt)),
      ),
      Effect.mapError(
        (cause) => new DesktopWindowCaptureError({ operation: "list-pending", cause }),
      ),
    ),
    read: (id) =>
      Effect.gen(function* () {
        const metadata = yield* fileSystem
          .readFileString(path.join(captureDirectory, `${id}.json`))
          .pipe(Effect.flatMap(decodePendingCaptureJson));
        const png = yield* fileSystem.readFile(path.join(captureDirectory, `${id}.png`));
        return {
          ...metadata,
          dataUrl: `data:image/png;base64,${Encoding.encodeBase64(png)}`,
        };
      }).pipe(
        Effect.mapError(
          (cause) => new DesktopWindowCaptureError({ operation: "read", captureId: id, cause }),
        ),
      ),
    acknowledge: (id) =>
      Effect.all(
        [
          fileSystem.remove(path.join(captureDirectory, `${id}.json`), { force: true }),
          fileSystem.remove(path.join(captureDirectory, `${id}.png`), { force: true }),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopWindowCaptureError({ operation: "acknowledge", captureId: id, cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopWindowCapture, make);
