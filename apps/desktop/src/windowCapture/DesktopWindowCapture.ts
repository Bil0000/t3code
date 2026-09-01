// @effect-diagnostics globalTimers:off -- Capture timeouts and Electron overlay animation timers run at native callback boundaries outside Effect fibers.

import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingWindowCapture,
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
import { captureMacWindowSnapshot, type MacWindowCaptureSource } from "./MacWindowCapture.ts";
import type { LinuxCaptureFeedback, LinuxWindowMetadata } from "./LinuxWindowCapture.ts";
import {
  captureRegionWindowSnapshot,
  type RegionWindowCaptureSource,
} from "./RegionWindowCapture.ts";
import {
  type WindowCaptureAnimationDestination,
  WindowCaptureTransition,
} from "./WindowCaptureTransition.ts";
import { startWindowCaptureAccessibilityProcess } from "./WindowCaptureAccessibilityProcess.ts";

import {
  hideAndWaitForBlur,
  isWaylandSession,
  toElectronAccelerator,
  windowCaptureShortcutRegistrationFailureMessage,
  windowCaptureShortcutSystemConflict,
} from "./windowCapture.ts";

const MAX_CAPTURE_WIDTH = 2_560;
const MAX_CAPTURE_HEIGHT = 1_600;
const CAPTURE_FAILED_ACTION = "window-capture-failed";
const WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE =
  "Modifier-pair shortcuts aren't available in this Wayland session. Choose another shortcut or use Capture window from the command palette.";
const FLASH_ANIMATION_DURATION_MS = 180;
const FLASH_STATIC_DURATION_MS = 60;
const FLASH_FRAME_INTERVAL_MS = 16;
const FLASH_PEAK_OPACITY = 0.08;
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
const DesktopWindowCaptureOperation = Schema.Literals([
  "list-pending",
  "read",
  "acknowledge",
  "unsupported",
  "disabled",
  "no-window-selected",
  "window-unavailable",
  "capture",
]);

export class DesktopWindowCaptureError extends Schema.TaggedErrorClass<DesktopWindowCaptureError>()(
  "DesktopWindowCaptureError",
  {
    operation: DesktopWindowCaptureOperation,
    captureId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
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
      case "unsupported":
        return "Window capture is not supported here.";
      case "disabled":
        return "Enable Window Capture in Settings first.";
      case "no-window-selected":
        return "No window was selected.";
      case "window-unavailable":
        return "The active window is not available for capture.";
      case "capture":
        return "Could not capture the active window.";
    }
  }
}

const isDesktopWindowCaptureError = Schema.is(DesktopWindowCaptureError);

function captureFailure(cause: unknown, captureId?: string): DesktopWindowCaptureError {
  return isDesktopWindowCaptureError(cause)
    ? cause
    : new DesktopWindowCaptureError({ operation: "capture", captureId, cause });
}

export class DesktopWindowCapture extends Context.Service<
  DesktopWindowCapture,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly requestPermissions: Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopWindowCaptureState>;
    readonly checkShortcut: (
      shortcut: WindowCaptureShortcut,
    ) => Effect.Effect<DesktopWindowCaptureShortcutAvailability>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly capture: Effect.Effect<void, DesktopWindowCaptureError>;
    readonly captureNow: Effect.Effect<void, DesktopWindowCaptureError>;
    readonly listPending: Effect.Effect<
      ReadonlyArray<DesktopPendingWindowCapture>,
      DesktopWindowCaptureError
    >;
    readonly read: (
      id: string,
    ) => Effect.Effect<DesktopWindowCaptureValue, DesktopWindowCaptureError>;
    readonly setAnimationDestination: (
      id: string,
      destination: WindowCaptureAnimationDestination,
    ) => Effect.Effect<void>;
    readonly dismissAnimation: (id: string) => Effect.Effect<void>;
    readonly acknowledge: (id: string) => Effect.Effect<void, DesktopWindowCaptureError>;
  }
>()("@t3tools/desktop/windowCapture/DesktopWindowCapture") {}

type WindowCaptureSystemAnimationSettings = Pick<
  ReturnType<typeof Electron.systemPreferences.getAnimationSettings>,
  "prefersReducedMotion" | "shouldRenderRichAnimation"
>;

function captureMode(platform: NodeJS.Platform): DesktopWindowCaptureState["mode"] {
  if (platform === "linux")
    return isWaylandSession(platform, process.env) ? "portal" : "unavailable";
  return platform === "darwin" || platform === "win32" ? "direct" : "unavailable";
}

export function shouldAnimateWindowCapture(
  settings: WindowCaptureSystemAnimationSettings,
): boolean {
  return settings.shouldRenderRichAnimation && !settings.prefersReducedMotion;
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

export function windowCaptureImageSize(png: Buffer, fallback: Electron.Rectangle): Electron.Size {
  try {
    const size = Electron.nativeImage.createFromBuffer(png).getSize();
    if (size.width > 0 && size.height > 0) return size;
  } catch {}
  return {
    width: Math.max(1, Math.round(fallback.width)),
    height: Math.max(1, Math.round(fallback.height)),
  };
}

async function captureSource({
  mode,
  captureId,
  platform,
  settings,
  flash,
  transition,
  imageTempPath,
  linuxAppId,
  accessibilityWorkerPath,
  onLinuxFeedback,
}: {
  mode: DesktopWindowCaptureState["mode"];
  captureId: string;
  platform: NodeJS.Platform;
  settings: ClientSettings;
  flash: WindowCaptureFlash;
  transition: WindowCaptureTransition;
  imageTempPath: string;
  linuxAppId: string;
  accessibilityWorkerPath: string;
  onLinuxFeedback: (feedback: LinuxCaptureFeedback) => void;
}) {
  let active: ActiveWindow | undefined;
  let linuxWindow: LinuxWindowMetadata | undefined;
  let linuxFeedback: LinuxCaptureFeedback | undefined;
  let linuxActivationFailure: { readonly cause: unknown } | undefined;
  const hiddenWindow = Electron.BrowserWindow.getFocusedWindow();
  const destinationWindow =
    hiddenWindow ?? Electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  const destinationWindowBounds = destinationWindow?.getBounds();
  let hiddenWindowRestored = false;
  const accessibilityProcess = startWindowCaptureAccessibilityProcess(accessibilityWorkerPath);
  let accessibilityProcessOwned = true;
  try {
    if (hiddenWindow) await hideAndWaitForBlur(hiddenWindow);
    if (mode === "direct") {
      active = await activeWindow({
        accessibilityPermission: false,
        screenRecordingPermission: platform === "darwin",
      });
    }

    let source: MacWindowCaptureSource | RegionWindowCaptureSource | Electron.DesktopCapturerSource;
    let png: Buffer;
    let imageTempReady = false;
    if (platform === "darwin") {
      if (!active) {
        throw new DesktopWindowCaptureError({ operation: "window-unavailable", captureId });
      }
      ({ source, png } = await captureMacWindowSnapshot(
        active,
        imageTempPath,
        windowCaptureThumbnailSize(active),
      ));
      imageTempReady = true;
    } else if (mode === "direct") {
      if (!active) {
        throw new DesktopWindowCaptureError({ operation: "window-unavailable", captureId });
      }
      ({ source, png } = await captureRegionWindowSnapshot(
        active,
        windowCaptureFlashBounds(active, platform),
        windowCaptureThumbnailSize(active),
      ));
    } else {
      const { captureLinuxWindow } = await import("./LinuxWindowCapture.ts");
      const snapshot = await captureLinuxWindow(linuxAppId, {
        flash: settings.windowCaptureFlash,
        animate:
          settings.windowCaptureAnimations &&
          shouldAnimateWindowCapture(Electron.systemPreferences.getAnimationSettings()),
      });
      if (snapshot) {
        linuxFeedback = snapshot.feedback;
        if (linuxFeedback) onLinuxFeedback(linuxFeedback);
        linuxWindow = snapshot.window;
        source = { name: linuxWindow?.title || "Active window" };
        png = snapshot.png;
      } else {
        const [selected] = await Electron.desktopCapturer.getSources({
          types: ["window", "screen"],
          thumbnailSize: windowCaptureThumbnailSize(active),
          fetchWindowIcons: true,
        });
        if (!selected || selected.thumbnail.isEmpty()) {
          throw new DesktopWindowCaptureError({
            operation: "no-window-selected",
            captureId,
          });
        }
        source = selected;
        png = selected.thumbnail.toPNG();
      }
    }
    const accessibleIdentity =
      active ??
      (linuxWindow?.processId
        ? {
            title: linuxWindow.title,
            bounds: linuxWindow.bounds,
            owner: { processId: linuxWindow.processId },
          }
        : undefined);
    const accessibilityRead = accessibleIdentity
      ? accessibilityProcess.read({
          active: accessibleIdentity,
          platform,
          sourceTitle: source.name,
          imageSize: windowCaptureImageSize(png, accessibleIdentity.bounds),
        })
      : undefined;
    if (accessibilityRead) {
      accessibilityProcessOwned = false;
      await accessibilityRead.started;
    } else {
      accessibilityProcess.close();
      accessibilityProcessOwned = false;
    }
    const contextPromise = accessibilityRead?.result ?? Promise.resolve(undefined);
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.show();
      hiddenWindowRestored = true;
    }
    if (linuxFeedback && destinationWindow && !destinationWindow.isDestroyed()) {
      if (destinationWindow.isMinimized()) destinationWindow.restore();
      if (!destinationWindow.isVisible()) destinationWindow.show();
      await linuxFeedback.activate(destinationWindow.getTitle()).catch((cause: unknown) => {
        linuxActivationFailure = { cause };
      });
    }
    const animationStarted =
      linuxFeedback?.animationStarted ??
      (await showCaptureFeedback(
        transition,
        flash,
        captureId,
        `data:image/png;base64,${png.toString("base64")}`,
        settings,
        active,
        platform,
        destinationWindowBounds,
      ));
    return {
      source,
      active,
      linuxWindow,
      linuxActivationFailure,
      contextPromise,
      animationStarted,
      png,
      imageTempReady,
    };
  } finally {
    if (accessibilityProcessOwned) accessibilityProcess.close();
    if (!hiddenWindowRestored && hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.show();
  }
}

function createWindowCaptureFlashWindow(bounds: Electron.Rectangle): Electron.BaseWindow {
  const window = new Electron.BaseWindow({
    ...bounds,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    opacity: FLASH_PEAK_OPACITY,
    transparent: false,
  });
  window.setIgnoreMouseEvents(true);
  return window;
}

export class WindowCaptureFlash {
  private flashWindow: Electron.BaseWindow | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

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
    const window = createWindowCaptureFlashWindow(bounds);
    this.flashWindow = window;
    if (window.isDestroyed()) return;
    window.showInactive();
    if (animated) {
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

export function windowCaptureFlashBounds(
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
): Electron.Rectangle {
  if (!active) return Electron.screen.getPrimaryDisplay().bounds;
  return platform === "win32"
    ? Electron.screen.screenToDipRect(null, active.bounds)
    : active.bounds;
}

async function showCaptureFeedback(
  transition: WindowCaptureTransition,
  flash: WindowCaptureFlash,
  captureId: string,
  snapshotDataUrl: string,
  settings: ClientSettings,
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
  destinationWindowBounds?: Electron.Rectangle,
): Promise<boolean> {
  // Wayland does not let this client position overlays on another app's window.
  if (platform === "linux") return false;
  const bounds = windowCaptureFlashBounds(active, platform);
  const animationsEnabled =
    settings.windowCaptureAnimations &&
    shouldAnimateWindowCapture(Electron.systemPreferences.getAnimationSettings());
  if (animationsEnabled) {
    try {
      await transition.begin(
        captureId,
        bounds,
        snapshotDataUrl,
        settings.windowCaptureFlash && platform !== "win32",
        destinationWindowBounds,
      );
      if (settings.windowCaptureFlash && platform === "win32") {
        await flash.showAnimated(bounds).catch(() => undefined);
      }
      return true;
    } catch {
      transition.dispose();
    }
  }
  if (!settings.windowCaptureFlash) return false;
  const playback = animationsEnabled ? flash.showAnimated(bounds) : flash.showStatic(bounds);
  await playback.catch(() => undefined);
  return false;
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
    shortcutMessage: null,
    message: null,
  });
  const busyRef = yield* Ref.make(false);
  const configurationMutex = yield* Semaphore.make(1);
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow
  >();
  const runPromise = Effect.runPromiseWith(context);
  const captureDirectory = path.join(environment.stateDir, "window-captures");
  const linuxAppId = environment.linuxDesktopEntryName.replace(/\.desktop$/, "");
  const shiftShortcutWorkerPath = path.join(
    __dirname,
    "windowCapture",
    "GlobalShiftShortcutWorker.cjs",
  );
  const accessibilityWorkerPath = path.join(
    __dirname,
    "windowCapture",
    "WindowCaptureAccessibilityWorker.cjs",
  );
  let registeredAccelerator: string | undefined;
  let shortcutSuppressed = false;
  let stopShiftShortcut: (() => void) | undefined;
  const flash = new WindowCaptureFlash();
  const transition = new WindowCaptureTransition({
    boundOverlayToFlight: environment.platform === "win32",
    boundOverlayToCaptureDisplays: environment.platform === "darwin",
    alwaysOnTopLevel: environment.platform === "linux" ? undefined : "pop-up-menu",
  });
  let linuxFeedback: { id: string; feedback: LinuxCaptureFeedback } | undefined;
  const closeLinuxFeedback = (id?: string) => {
    if (!linuxFeedback || (id !== undefined && linuxFeedback.id !== id)) return;
    linuxFeedback.feedback.close();
    linuxFeedback = undefined;
  };
  const completeLinuxFeedback = async (id: string) => {
    if (linuxFeedback?.id !== id) return;
    const pending = linuxFeedback;
    await pending.feedback.complete().catch(() => undefined);
    if (linuxFeedback === pending) linuxFeedback = undefined;
  };

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

  const notifyFailure = desktopWindow
    .dispatchMenuAction(CAPTURE_FAILED_ACTION)
    .pipe(Effect.catch(() => Effect.void));
  const setFailure = (message: string) =>
    Ref.update(stateRef, (state) => ({ ...state, message })).pipe(Effect.andThen(notifyFailure));
  const setShortcutFailure = (shortcutMessage: string) =>
    Ref.update(stateRef, (state) => ({
      ...state,
      shortcutRegistered: false,
      shortcutMessage,
    })).pipe(Effect.andThen(notifyFailure));

  const persistCapture = Effect.fn("desktop.windowCapture.persistCapture")(function* (
    settings: ClientSettings,
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => captureFailure(cause)));
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return yield* new DesktopWindowCaptureError({ operation: "unsupported", captureId: id });
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
      const {
        source,
        active,
        linuxWindow,
        linuxActivationFailure,
        contextPromise,
        animationStarted,
        png,
        imageTempReady,
      } = yield* Effect.tryPromise({
        try: () =>
          captureSource({
            mode,
            captureId: id,
            platform: environment.platform,
            settings,
            flash,
            transition,
            imageTempPath,
            linuxAppId,
            accessibilityWorkerPath,
            onLinuxFeedback: (feedback) => {
              linuxFeedback = { id, feedback };
            },
          }),
        catch: (cause) => captureFailure(cause, id),
      });
      if (linuxActivationFailure) {
        yield* Effect.logWarning(
          "GNOME could not activate T3 Code after window capture",
          linuxActivationFailure.cause,
        );
      }
      if (animationStarted) {
        yield* desktopWindow
          .dispatchMenuAction(`window-capture-started:${id}`)
          .pipe(Effect.catch(() => Effect.void));
      }
      const accessibilityContext = yield* Effect.promise(() => contextPromise);
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
          appName:
            active?.owner.name.trim() ||
            linuxWindow?.appName.trim() ||
            source.name.trim() ||
            "Window",
          windowTitle: active?.title.trim() || linuxWindow?.title.trim() || source.name.trim(),
          ...(accessibilityContext?.accessibleText
            ? { accessibleText: accessibilityContext.accessibleText }
            : {}),
          ...(accessibilityContext?.accessibility
            ? { accessibility: accessibilityContext.accessibility }
            : {}),
          ...(active?.platform === "macos" && active.owner.bundleId
            ? { appIdentifier: active.owner.bundleId }
            : linuxWindow?.appIdentifier
              ? { appIdentifier: linuxWindow.appIdentifier }
              : {}),
          ...(appIconDataUrl ? { appIconDataUrl } : {}),
        },
      });
      if (!imageTempReady) yield* fileSystem.writeFile(imageTempPath, png);
      yield* fileSystem.rename(imageTempPath, imagePath);
      yield* fileSystem.writeFileString(
        metadataPath + ".tmp",
        yield* encodePendingCaptureJson(pending),
      );
      yield* fileSystem.rename(metadataPath + ".tmp", metadataPath);
    }).pipe(
      Effect.mapError((cause) => captureFailure(cause, id)),
      Effect.tapError(() =>
        cleanup.pipe(
          Effect.andThen(
            Effect.promise(async () => {
              closeLinuxFeedback(id);
              await transition.complete(id);
            }),
          ),
        ),
      ),
    );
    return id;
  });

  const captureNow = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    if (yield* Ref.getAndSet(busyRef, true)) return;
    closeLinuxFeedback();
    yield* persistCapture(settings).pipe(
      Effect.tap((id) =>
        Ref.update(stateRef, (state) => ({ ...state, message: null })).pipe(
          Effect.andThen(
            desktopWindow.dispatchWindowCaptureReady(id).pipe(Effect.catch(() => Effect.void)),
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
      return yield* new DesktopWindowCaptureError({ operation: "disabled" });
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
    if (isModifierPairShortcut(shortcut)) {
      if (mode === "portal") {
        return { available: false, message: WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE };
      }
      const available = yield* Effect.tryPromise(() =>
        startPairShortcutProcess(
          windowCaptureShortcutModifierPair(shortcut),
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
          ? observedPairMessage(shortcut, environment.platform)
          : windowCaptureShortcutRegistrationFailureMessage(shortcut, environment.platform),
      };
    }
    const systemConflict = windowCaptureShortcutSystemConflict(shortcut);
    if (systemConflict) return { available: false, message: systemConflict };
    if (mode === "portal") {
      return {
        available: true,
        message: "Your desktop will confirm this shortcut when you save it.",
      };
    }
    const accelerator = toElectronAccelerator(shortcut);
    const available =
      registeredAccelerator === accelerator
        ? { available: true, message: null }
        : probeGlobalShortcut(accelerator);
    return available;
  });

  const applySettings = Effect.fn("desktop.windowCapture.applySettings")(function* (
    settings: ClientSettings,
    requestedPermissionMessage: string | null,
  ) {
    yield* Ref.set(settingsRef, settings);
    releaseShortcut();

    const mode = captureMode(environment.platform);
    const shortcut = settings.windowCaptureShortcut;
    if (!settings.windowCaptureEnabled || !settings.windowCaptureFlash || mode === "unavailable") {
      flash.dispose();
    }
    if (
      !settings.windowCaptureEnabled ||
      !settings.windowCaptureAnimations ||
      mode === "unavailable"
    ) {
      transition.dispose();
      closeLinuxFeedback();
    }
    if (!settings.windowCaptureEnabled || mode === "unavailable") {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        shortcutMessage: null,
        message:
          mode === "unavailable"
            ? environment.platform === "linux"
              ? "Window capture requires a Wayland session. X11 capture is not supported."
              : "Window capture is not supported on this platform."
            : null,
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
        shortcutMessage: null,
        message: permissionMessage,
      });
      return;
    }
    if (mode === "portal" && isModifierPairShortcut(shortcut)) {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        shortcutMessage: WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE,
        message: null,
      });
      return;
    }

    let registered = false;
    if (isModifierPairShortcut(shortcut)) {
      registered = yield* Effect.tryPromise(() =>
        startPairShortcutProcess(
          windowCaptureShortcutModifierPair(shortcut),
          () => {
            if (shortcutSuppressed) return;
            void runPromise(capture).catch(() => undefined);
          },
          () => {
            void runPromise(
              setShortcutFailure(
                windowCaptureShortcutRegistrationFailureMessage(shortcut, environment.platform),
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
        if (shortcutSuppressed) return;
        void runPromise(capture).catch(() => undefined);
      });
      if (registered) registeredAccelerator = accelerator;
    }

    yield* Ref.set(stateRef, {
      mode,
      shortcut,
      shortcutRegistered: registered,
      message: null,
      // Electron's portal result only confirms submission, not desktop consent.
      shortcutMessage:
        mode === "portal"
          ? registered
            ? "Requested from your desktop. Approve the system prompt to enable this shortcut."
            : "Your desktop could not register this shortcut. Check global shortcut support and permissions."
          : registered
            ? isModifierPairShortcut(shortcut)
              ? observedPairMessage(shortcut, environment.platform)
              : null
            : windowCaptureShortcutRegistrationFailureMessage(shortcut, environment.platform),
    });
  });

  const setShortcutSuppressed = (suppressed: boolean) =>
    Effect.sync(() => {
      shortcutSuppressed = suppressed;
    });

  const configure = Effect.fn("desktop.windowCapture.configure")(function* (
    settings: ClientSettings,
  ) {
    yield* configurationMutex.withPermits(1)(applySettings(settings, null));
  });

  const requestPermissions = configurationMutex.withPermits(1)(
    environment.platform === "darwin"
      ? Effect.promise(requestMacWindowCapturePermissions).pipe(Effect.asVoid)
      : Effect.void,
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseShortcut();
      flash.dispose();
      transition.dispose();
      closeLinuxFeedback();
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
    requestPermissions,
    state: Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.mode === "portal"
          ? Effect.tryPromise(async () => {
              const { getLinuxCaptureSupport } = await import("./LinuxWindowCapture.ts");
              return getLinuxCaptureSupport(linuxAppId);
            }).pipe(
              Effect.map((support) => ({ ...state, ...support })),
              Effect.orElseSucceed(() => state),
            )
          : Effect.succeed(state),
      ),
    ),
    checkShortcut,
    setShortcutSuppressed,
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
    setAnimationDestination: (id, destination) =>
      Effect.promise(async () => {
        if (linuxFeedback?.id === id && destination.relativeFrame) {
          await linuxFeedback.feedback
            .animateTo(destination.relativeFrame)
            .catch(() => closeLinuxFeedback(id));
          return;
        }
        transition.animateTo(id, destination);
        await transition.waitForLanding(id);
      }),
    dismissAnimation: (id) =>
      Effect.sync(() => {
        closeLinuxFeedback(id);
        transition.dismiss(id);
      }),
    acknowledge: (id) =>
      Effect.promise(async () => {
        await completeLinuxFeedback(id);
        await transition.complete(id);
      }).pipe(
        Effect.andThen(
          Effect.all(
            [
              fileSystem.remove(path.join(captureDirectory, `${id}.json`), { force: true }),
              fileSystem.remove(path.join(captureDirectory, `${id}.png`), { force: true }),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
        Effect.mapError(
          (cause) =>
            new DesktopWindowCaptureError({ operation: "acknowledge", captureId: id, cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopWindowCapture, make);
