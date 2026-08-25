// @effect-diagnostics globalTimers:off

import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingWindowCapture,
  effectiveWindowCaptureShortcut,
  WINDOW_CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS,
  isModifierPairShortcut,
  windowCaptureModifierPairLabel,
  windowCaptureShortcutModifierPair,
  type DesktopWindowCapture as DesktopWindowCaptureValue,
  type DesktopWindowCaptureShortcutAvailability,
  type DesktopWindowCaptureState,
  type ClientSettings,
  type WindowCaptureModifier,
  type WindowCaptureModifierPairShortcut,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
import { startGlobalShiftShortcutProcess } from "./GlobalShiftShortcutProcess.ts";
import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.ts";
import {
  accessibleWindowText,
  findAccessibleWindow,
  findCaptureSource,
  hideAndWaitForBlur,
  isWaylandSession,
  WAYLAND_SUBSTITUTION_MESSAGE,
  shouldRequestScreenCapturePermission,
  toElectronAccelerator,
  windowCaptureShortcutRegistrationFailureMessage,
  windowCaptureShortcutSystemConflict,
} from "./windowCapture.ts";

const MAX_CAPTURE_WIDTH = 2_560;
const MAX_CAPTURE_HEIGHT = 1_600;
const ACCESSIBLE_TEXT_TIMEOUT_MS = 1_000;
const CAPTURE_READY_ACTION = "window-capture-ready";
const CAPTURE_FAILED_ACTION = "window-capture-failed";
const FLASH_ANIMATION_DURATION_MS = 180;
const FLASH_STATIC_DURATION_MS = 60;
const FLASH_FRAME_INTERVAL_MS = 16;
const FLASH_PEAK_OPACITY = 0.14;
const MAC_SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE =
  "Allow Screen Recording in System Settings, then restart T3 Code.";
const MAC_ACCESSIBILITY_PERMISSION_MESSAGE =
  "Allow Accessibility in System Settings, then restart T3 Code.";

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

export function windowCaptureThumbnailSize(active: ActiveWindow | undefined): Electron.Size {
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
  return icon.resize({ width: 64, height: 64, quality: "best" }).toDataURL({ scaleFactor: 2 });
}

async function appFileIcon(
  path: string,
  platform: NodeJS.Platform,
): Promise<Electron.NativeImage | undefined> {
  if (platform === "darwin") {
    const thumbnail = await Electron.nativeImage
      .createThumbnailFromPath(path, { width: 64, height: 64 })
      .catch(() => undefined);
    if (thumbnail && !thumbnail.isEmpty()) return thumbnail;
  }
  return Electron.app.getFileIcon(path, { size: "normal" }).catch(() => undefined);
}

export async function iconDataUrl(
  source: { readonly appIcon?: Electron.NativeImage | null },
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  try {
    const fileIcon = active?.owner.path
      ? await appFileIcon(active.owner.path, platform)
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
    return MAC_ACCESSIBILITY_PERMISSION_MESSAGE;
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

let activeAccessibleTextRead: Promise<string | undefined> | undefined;

export async function readAccessibleWindowText(
  active: ActiveWindow,
  platform: NodeJS.Platform,
  sourceTitle: string,
): Promise<string | undefined> {
  if (activeAccessibleTextRead) return undefined;
  const read = readCapturedWindowText(active, platform, sourceTitle).catch(() => undefined);
  activeAccessibleTextRead = read;
  void read.finally(() => {
    if (activeAccessibleTextRead === read) activeAccessibleTextRead = undefined;
  });
  let timeout: number | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(resolve, ACCESSIBLE_TEXT_TIMEOUT_MS);
      }),
    ]);
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
      thumbnailSize: windowCaptureThumbnailSize(active),
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

function createWindowCaptureFlashWindow(
  bounds: Electron.Rectangle,
  platform: NodeJS.Platform,
): Electron.BaseWindow {
  const options = {
    ...bounds,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
  };
  const window =
    platform === "linux"
      ? new Electron.BrowserWindow({ ...options, transparent: true })
      : new Electron.BaseWindow({
          ...options,
          backgroundColor: "#ffffff",
          opacity: FLASH_PEAK_OPACITY,
          transparent: false,
        });
  window.setIgnoreMouseEvents(true);
  return window;
}

export class WindowCaptureFlash {
  private readonly platform: NodeJS.Platform;
  private flashWindow: Electron.BaseWindow | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  showAnimated(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, true, FLASH_ANIMATION_DURATION_MS);
  }

  showStatic(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, false, FLASH_STATIC_DURATION_MS);
  }

  dispose(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.animationTimer = undefined;
    this.closeTimer = undefined;
    if (this.flashWindow && !this.flashWindow.isDestroyed()) this.flashWindow.destroy();
    this.flashWindow = undefined;
  }

  private async show(
    bounds: Electron.Rectangle,
    animated: boolean,
    durationMs: number,
  ): Promise<void> {
    this.dispose();
    const window = createWindowCaptureFlashWindow(bounds, this.platform);
    this.flashWindow = window;
    if (window instanceof Electron.BrowserWindow) {
      const animation = animated
        ? "animation:flash " + FLASH_ANIMATION_DURATION_MS + "ms cubic-bezier(.2,.8,.2,1) both"
        : "opacity:1";
      const html =
        '<!doctype html><style>@keyframes flash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}</style><body style="margin:0;background:rgba(255,255,255,.14);' +
        animation +
        '"></body>';
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    }
    if (window.isDestroyed()) return;
    window.showInactive();
    if (animated && this.platform !== "linux") {
      let opacity = FLASH_PEAK_OPACITY;
      this.animationTimer = setInterval(() => {
        if (window.isDestroyed()) return this.dispose();
        opacity = Math.max(
          0,
          opacity - (FLASH_PEAK_OPACITY * FLASH_FRAME_INTERVAL_MS) / durationMs,
        );
        window.setOpacity(opacity);
      }, FLASH_FRAME_INTERVAL_MS);
    }
    this.closeTimer = setTimeout(() => {
      if (this.flashWindow === window) this.dispose();
    }, durationMs);
  }
}

export function windowCaptureFlashBounds(active: ActiveWindow | undefined): Electron.Rectangle {
  return active?.bounds ?? Electron.screen.getPrimaryDisplay().bounds;
}

function showFlash(
  flash: WindowCaptureFlash,
  settings: ClientSettings,
  active: ActiveWindow | undefined,
): void {
  if (!settings.windowCaptureFlash) return;
  const bounds = windowCaptureFlashBounds(active);
  const playback = settings.windowCaptureAnimations
    ? flash.showAnimated(bounds)
    : flash.showStatic(bounds);
  void playback.catch(() => undefined);
}

function observedPairMessage(
  shortcut: WindowCaptureModifierPairShortcut,
  platform: NodeJS.Platform,
): string {
  const modifier = windowCaptureShortcutModifierPair(shortcut);
  const label = windowCaptureModifierPairLabel(modifier, platform === "darwin");
  const base = `${label} is observed and cannot be reserved exclusively.`;
  if (modifier === "meta" && platform !== "darwin") {
    return `${base} This key can also open the system's own menu.`;
  }
  if (modifier === "alt" && platform === "win32") {
    return `${base} This key can also activate app menu bars.`;
  }
  return base;
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
  const shiftShortcutWorkerPath = path.join(
    __dirname,
    "windowCapture",
    "GlobalShiftShortcutWorker.cjs",
  );
  let registeredAccelerator: string | undefined;
  let stopShiftShortcut: (() => void) | undefined;
  const flash = new WindowCaptureFlash(environment.platform);

  const startPairShortcutProcess = (
    modifier: WindowCaptureModifier,
    onTrigger: () => void,
    onFailure: (error: Error) => void,
  ) =>
    environment.platform === "darwin"
      ? startMacModifierPairShortcutProcess(modifier, onTrigger, onFailure)
      : startGlobalShiftShortcutProcess(shiftShortcutWorkerPath, modifier, onTrigger, onFailure);

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
      const capturedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const appIconDataUrl = yield* Effect.promise(() =>
        iconDataUrl(source, active, environment.platform),
      );
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
    const effectiveShortcut = effectiveWindowCaptureShortcut(mode, shortcut);
    if (isModifierPairShortcut(effectiveShortcut)) {
      const available = yield* Effect.tryPromise(() =>
        startPairShortcutProcess(
          windowCaptureShortcutModifierPair(effectiveShortcut),
          () => undefined,
          () => undefined,
        ),
      ).pipe(
        Effect.tap((stop) => Effect.sync(stop)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return {
        available,
        message: available
          ? observedPairMessage(effectiveShortcut, environment.platform)
          : windowCaptureShortcutRegistrationFailureMessage(
              effectiveShortcut,
              environment.platform,
            ),
      };
    }
    const systemConflict = windowCaptureShortcutSystemConflict(effectiveShortcut);
    if (systemConflict) return { available: false, message: systemConflict };
    const accelerator = toElectronAccelerator(effectiveShortcut);
    const available =
      registeredAccelerator === accelerator
        ? { available: true, message: null }
        : probeGlobalShortcut(accelerator);
    if (mode === "portal" && isModifierPairShortcut(shortcut)) {
      return available.available
        ? { available: true, message: WAYLAND_SUBSTITUTION_MESSAGE }
        : {
            available: false,
            message: [WAYLAND_SUBSTITUTION_MESSAGE, available.message].filter(Boolean).join(" "),
          };
    }
    return available;
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
    if (isModifierPairShortcut(shortcut)) {
      registered = yield* Effect.tryPromise(() =>
        startPairShortcutProcess(
          windowCaptureShortcutModifierPair(shortcut),
          () => {
            void runPromise(capture).catch(() => undefined);
          },
          () => {
            void runPromise(
              Ref.update(stateRef, (state) => ({ ...state, shortcutRegistered: false })).pipe(
                Effect.andThen(
                  setFailure(
                    windowCaptureShortcutRegistrationFailureMessage(shortcut, environment.platform),
                  ),
                ),
              ),
            ).catch(() => undefined);
          },
        ),
      ).pipe(
        Effect.tap((stop) =>
          Effect.sync(() => {
            stopShiftShortcut = stop;
          }),
        ),
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
        ? mode === "portal" && isModifierPairShortcut(settings.windowCaptureShortcut)
          ? WAYLAND_SUBSTITUTION_MESSAGE
          : isModifierPairShortcut(shortcut)
            ? observedPairMessage(shortcut, environment.platform)
            : null
        : windowCaptureShortcutRegistrationFailureMessage(shortcut, environment.platform),
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
