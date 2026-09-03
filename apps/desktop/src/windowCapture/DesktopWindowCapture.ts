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
  DesktopWindowCaptureSetupAction,
  type DesktopCaptureConfigRequest,
  type DesktopCaptureConfigPreview,
  type DesktopCaptureConfigApplied,
  type ClientSettings,
  type WindowCaptureModifier,
  type WindowCaptureModifierPairShortcut,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import { niriSocketPath } from "./NiriWindowCapture.ts";
import { niriCaptureBinding, startNiriCaptureShortcut } from "./NiriCaptureShortcut.ts";
import { CaptureShortcutConfig, niriCaptureConfigPath } from "./CaptureShortcutConfig.ts";
import { GnomeCaptureSetup, isGnomeCaptureSession } from "./GnomeCaptureSetup.ts";
import { PortalCaptureShortcut, portalShortcutTrigger } from "./PortalCaptureShortcut.ts";
import {
  HyprlandCaptureSetup,
  HYPRLAND_CAPTURE_EXECUTABLE,
  isHyprlandCaptureSession,
  hyprlandCaptureShortcut,
  type HyprlandCapturePaths,
} from "./HyprlandWindowCapture.ts";
import {
  KdeCaptureSetup,
  KDE_CAPTURE_EXECUTABLE,
  isKdeCaptureSession,
  type KdeCapturePaths,
} from "./KdeWindowCapture.ts";
import {
  captureRegionWindowSnapshot,
  type RegionWindowCaptureSource,
} from "./RegionWindowCapture.ts";
import {
  type WindowCaptureAnimationDestination,
  WindowCaptureTransition,
} from "./WindowCaptureTransition.ts";
import { startWindowCaptureAccessibilityProcess } from "./WindowCaptureAccessibilityProcess.ts";
import { showWindowsCaptureOverlay } from "./WindowsCaptureFeedback.ts";

import {
  hideAndWaitForBlur,
  isWaylandSession,
  toElectronAccelerator,
  windowCaptureShortcutRegistrationFailureMessage,
  windowCaptureShortcutSystemConflict,
} from "./windowCapture.ts";

const MAX_CAPTURE_WIDTH = 2_560;
const MAX_CAPTURE_HEIGHT = 1_600;
const SHORTCUT_COOLDOWN_NS = 200_000_000n;
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
    readonly requestPermissions: (includeAccessibility: boolean) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopWindowCaptureState>;
    readonly setup: (
      action: DesktopWindowCaptureSetupAction,
    ) => Effect.Effect<void, DesktopWindowCaptureSetupError>;
    readonly previewConfig: (
      request: DesktopCaptureConfigRequest,
      selectedPath?: string,
    ) => Effect.Effect<DesktopCaptureConfigPreview, DesktopWindowCaptureSetupError>;
    readonly applyConfig: (
      previewId: string,
    ) => Effect.Effect<DesktopCaptureConfigApplied, DesktopWindowCaptureSetupError>;
    readonly checkShortcut: (
      shortcut: WindowCaptureShortcut,
    ) => Effect.Effect<DesktopWindowCaptureShortcutAvailability>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    /** Capture the foreground window in place, including T3 Code itself. */
    readonly capture: Effect.Effect<void, DesktopWindowCaptureError>;
    /** Capture from the command palette, revealing the previous app first. */
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

export class DesktopWindowCaptureSetupError extends Schema.TaggedErrorClass<DesktopWindowCaptureSetupError>()(
  "DesktopWindowCaptureSetupError",
  {
    action: Schema.Union([
      DesktopWindowCaptureSetupAction,
      Schema.Literals(["preview-config", "apply-config"]),
    ]),
    reason: Schema.Literals(["unsupported-session", "setup-failed", "shortcut-permissions"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.action === "preview-config" || this.action === "apply-config") {
      if (this.reason === "unsupported-session")
        return "Config setup requires a Niri or Hyprland session.";
      return this.action === "preview-config"
        ? "Couldn't prepare your capture shortcut changes."
        : "Couldn't save your capture shortcut.";
    }
    const kde = this.action === "install-kde-helper" || this.action === "remove-kde-helper";
    const hyprland =
      this.action === "install-hyprland-helper" || this.action === "remove-hyprland-helper";
    if (this.reason === "unsupported-session")
      return hyprland
        ? "Helper setup requires a Hyprland Wayland session outside a sandbox."
        : kde
          ? "Helper setup requires a KDE Plasma Wayland session outside a sandbox."
          : "Extension setup requires a GNOME Wayland session outside a sandbox.";
    if (this.reason === "shortcut-permissions") return "Could not open shortcut permissions.";
    return hyprland
      ? "Could not set up Hyprland capture."
      : kde
        ? "Could not set up KDE capture."
        : "Could not set up the GNOME extension.";
  }
}

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

function currentMacWindowCapturePermissionMessage(includeAccessibility: boolean): string | null {
  const accessibilityGranted =
    !includeAccessibility || Electron.systemPreferences.isTrustedAccessibilityClient(false);
  const screenGranted = Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
  if (!accessibilityGranted && !screenGranted) {
    return "Allow Accessibility and Screen Recording in System Settings, then restart T3 Code.";
  }
  if (!accessibilityGranted) {
    return MAC_ACCESSIBILITY_PERMISSION_MESSAGE;
  }
  return screenGranted ? null : MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
}

async function requestMacWindowCapturePermissions(
  includeAccessibility: boolean,
): Promise<string | null> {
  const accessibilityGranted =
    !includeAccessibility || Electron.systemPreferences.isTrustedAccessibilityClient(true);
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

type WindowCaptureTarget = "foreground" | "previous-app";

async function captureSource({
  target,
  mode,
  captureId,
  platform,
  settings,
  flash,
  transition,
  imageTempPath,
  linuxAppId,
  kdeCapturePaths,
  hyprlandCapturePaths,
  accessibilityWorkerPath,
  onLinuxFeedback,
}: {
  target: WindowCaptureTarget;
  mode: DesktopWindowCaptureState["mode"];
  captureId: string;
  platform: NodeJS.Platform;
  settings: ClientSettings;
  flash: WindowCaptureFlash;
  transition: WindowCaptureTransition;
  imageTempPath: string;
  linuxAppId: string;
  kdeCapturePaths: KdeCapturePaths;
  hyprlandCapturePaths: HyprlandCapturePaths;
  accessibilityWorkerPath: string;
  onLinuxFeedback: (feedback: LinuxCaptureFeedback) => void;
}) {
  let active: ActiveWindow | undefined;
  let linuxWindow: LinuxWindowMetadata | undefined;
  let linuxFeedback: LinuxCaptureFeedback | undefined;
  let linuxActivationFailure: { readonly cause: unknown } | undefined;
  const focusedWindow = Electron.BrowserWindow.getFocusedWindow();
  const hiddenWindow = target === "previous-app" ? focusedWindow : undefined;
  const destinationWindow =
    focusedWindow ?? Electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  const destinationWindowBounds = destinationWindow?.getBounds();
  let hiddenWindowRestored = false;
  const accessibilityProcess = settings.windowCaptureIncludeAccessibility
    ? startWindowCaptureAccessibilityProcess(accessibilityWorkerPath)
    : undefined;
  let accessibilityProcessOwned = accessibilityProcess !== undefined;
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
      const snapshot = await captureLinuxWindow(
        linuxAppId,
        {
          flash: settings.windowCaptureFlash,
          animate:
            settings.windowCaptureAnimations &&
            shouldAnimateWindowCapture(Electron.systemPreferences.getAnimationSettings()),
        },
        kdeCapturePaths,
        hyprlandCapturePaths,
      );
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
    const accessibleIdentity = active
      ? { ...active, bounds: windowCaptureFlashBounds(active, platform) }
      : linuxWindow?.processId
        ? {
            title: linuxWindow.title,
            bounds: linuxWindow.bounds,
            ...(linuxWindow.clientBounds ? { clientBounds: linuxWindow.clientBounds } : {}),
            owner: { processId: linuxWindow.processId },
            ...(linuxWindow.accessibilityBoundsReliable === false
              ? { accessibilityBoundsReliable: false }
              : {}),
          }
        : undefined;
    const accessibilityRead =
      accessibleIdentity && accessibilityProcess
        ? accessibilityProcess.read({
            active: accessibleIdentity,
            platform,
            sourceTitle: source.name,
            imageSize: windowCaptureImageSize(png, active?.bounds ?? accessibleIdentity.bounds),
          })
        : undefined;
    if (accessibilityRead) {
      accessibilityProcessOwned = false;
      await accessibilityRead.started;
    } else {
      accessibilityProcess?.close();
      accessibilityProcessOwned = false;
    }
    const contextPromise = accessibilityRead?.result ?? Promise.resolve(undefined);
    if (platform !== "win32" && hiddenWindow && !hiddenWindow.isDestroyed()) {
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
    if (platform === "win32" && hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.show();
      hiddenWindowRestored = true;
    }
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
    if (accessibilityProcessOwned) accessibilityProcess?.close();
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
  private readonly showWindow: (window: Electron.BaseWindow) => void;

  constructor(
    showWindow: (window: Electron.BaseWindow) => void = (window) => window.showInactive(),
  ) {
    this.showWindow = showWindow;
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
    const window = createWindowCaptureFlashWindow(bounds);
    this.flashWindow = window;
    if (window.isDestroyed()) return;
    this.showWindow(window);
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
        settings.windowCaptureFlash,
        destinationWindowBounds,
      );
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
  const snapshotMutex = yield* Semaphore.make(1);
  const configurationMutex = yield* Semaphore.make(1);
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow
  >();
  const runPromise = Effect.runPromiseWith(context);
  const captureDirectory = path.join(environment.stateDir, "window-captures");
  const linuxAppId = environment.linuxDesktopEntryName.replace(/\.desktop$/, "");
  let shortcutVerified = false;
  const gnomeSetupPaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "gnome-extension")
      : path.join(environment.appRoot, "apps/desktop/gnome-extension"),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const kdeCapturePaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "kde-capture", KDE_CAPTURE_EXECUTABLE)
      : path.join(
          environment.appRoot,
          "native/kde-window-capture/target/release",
          KDE_CAPTURE_EXECUTABLE,
        ),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const hasGnomeSetup = () =>
    captureMode(environment.platform) === "portal" && isGnomeCaptureSession(process.env);
  const hyprlandCapturePaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "hyprland-capture", HYPRLAND_CAPTURE_EXECUTABLE)
      : path.join(
          environment.appRoot,
          "native/hyprland-window-capture/target/release",
          HYPRLAND_CAPTURE_EXECUTABLE,
        ),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const shiftShortcutWorkerPath = path.join(
    __dirname,
    "windowCapture",
    "GlobalShiftShortcutWorker.cjs",
  );
  const shortcutConfig = new CaptureShortcutConfig();
  const accessibilityWorkerPath = path.join(
    __dirname,
    "windowCapture",
    "WindowCaptureAccessibilityWorker.cjs",
  );
  let registeredAccelerator: string | undefined;
  let portalShortcut: PortalCaptureShortcut | undefined;
  let shortcutGeneration = 0;
  let shortcutSuppressed = false;
  let lastShortcutAt: bigint | undefined;
  let stopShiftShortcut: (() => void) | undefined;
  const showCaptureWindow =
    environment.platform === "win32" ? showWindowsCaptureOverlay : undefined;
  const flash = new WindowCaptureFlash(showCaptureWindow);
  const transition = new WindowCaptureTransition({
    showWindow: showCaptureWindow,
    waitForCompositorFrame: environment.platform === "win32",
    // Transparent Windows surfaces must not resize while their compositor animation is running.
    boundOverlayToCaptureDisplays: environment.platform !== "linux",
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
    shortcutGeneration++;
    portalShortcut?.close();
    portalShortcut = undefined;
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
    Effect.sync(() => {
      shortcutVerified = false;
    }).pipe(
      Effect.andThen(
        Ref.update(stateRef, (state) => ({
          ...state,
          shortcutRegistered: false,
          shortcutMessage,
        })),
      ),
      Effect.andThen(notifyFailure),
    );

  const discardCapture = Effect.fn("desktop.windowCapture.discardCapture")(function* (id: string) {
    closeLinuxFeedback(id);
    transition.dismiss(id);
    yield* Effect.all(
      [`${id}.png`, `${id}.tmp.png`, `${id}.json`, `${id}.json.tmp`].map((name) =>
        fileSystem.remove(path.join(captureDirectory, name), { force: true }),
      ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.ignore);
  });

  const prepareCapture = Effect.fn("desktop.windowCapture.prepareCapture")(function* (
    settings: ClientSettings,
    target: WindowCaptureTarget,
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => captureFailure(cause)));
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return yield* new DesktopWindowCaptureError({ operation: "unsupported", captureId: id });
    }
    const imageTempPath = path.join(captureDirectory, `${id}.tmp.png`);

    return yield* Effect.gen(function* () {
      // Retire feedback before reading screen pixels, so a rapid capture cannot
      // photograph the previous capture's overlay.
      closeLinuxFeedback();
      flash.dispose();
      transition.dispose();
      yield* fileSystem.makeDirectory(captureDirectory, { recursive: true });
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          captureSource({
            target,
            mode,
            captureId: id,
            platform: environment.platform,
            settings,
            flash,
            transition,
            imageTempPath,
            linuxAppId,
            kdeCapturePaths,
            hyprlandCapturePaths,
            accessibilityWorkerPath,
            onLinuxFeedback: (feedback) => {
              linuxFeedback = { id, feedback };
            },
          }),
        catch: (cause) => captureFailure(cause, id),
      });
      const capturedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      if (snapshot.linuxActivationFailure) {
        yield* Effect.logWarning(
          "The compositor could not activate T3 Code after window capture",
          snapshot.linuxActivationFailure.cause,
        );
      }
      if (snapshot.animationStarted) {
        yield* desktopWindow
          .dispatchMenuAction(`window-capture-started:${id}`)
          .pipe(Effect.catch(() => Effect.void));
      } else {
        yield* desktopWindow.activate.pipe(Effect.catch(() => Effect.void));
      }
      return { id, capturedAt, ...snapshot };
    }).pipe(Effect.mapError((cause) => captureFailure(cause, id)));
  });

  const persistCapture = Effect.fn("desktop.windowCapture.persistCapture")(function* (
    capture: Effect.Success<ReturnType<typeof prepareCapture>>,
  ) {
    const { id, capturedAt, source, active, linuxWindow, contextPromise, png, imageTempReady } =
      capture;
    const imagePath = path.join(captureDirectory, `${id}.png`);
    const imageTempPath = path.join(captureDirectory, `${id}.tmp.png`);
    const metadataPath = path.join(captureDirectory, `${id}.json`);

    yield* Effect.gen(function* () {
      const accessibilityContext = yield* Effect.promise(() => contextPromise);
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
    }).pipe(Effect.mapError((cause) => captureFailure(cause, id)));
  });

  const captureTarget = Effect.fn("desktop.windowCapture.captureTarget")(function* (
    target: WindowCaptureTarget,
  ) {
    const settings = yield* Ref.get(settingsRef);
    // Only source acquisition and the initial handoff require exclusive access.
    // Each captured image can finish its own accessibility read and persistence.
    const prepared = yield* prepareCapture(settings, target).pipe(
      Effect.tapError((error) =>
        (error.captureId ? discardCapture(error.captureId) : Effect.void).pipe(
          Effect.andThen(setFailure(error.message)),
        ),
      ),
      snapshotMutex.withPermitsIfAvailable(1),
    );
    if (Option.isNone(prepared)) return;
    const capture = prepared.value;
    yield* persistCapture(capture).pipe(
      Effect.tap(() =>
        Ref.update(stateRef, (state) => ({ ...state, message: null })).pipe(
          Effect.andThen(
            desktopWindow
              .dispatchWindowCaptureReady(capture.id)
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      ),
      Effect.tapError((error) =>
        discardCapture(capture.id).pipe(
          Effect.andThen(Ref.update(stateRef, (state) => ({ ...state, message: error.message }))),
          Effect.andThen(
            desktopWindow
              .dispatchMenuAction(`${CAPTURE_FAILED_ACTION}:${capture.id}`, { reveal: false })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      ),
    );
  });

  const captureNow = captureTarget("previous-app");

  const capture = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    if (!settings.windowCaptureEnabled) {
      return yield* new DesktopWindowCaptureError({ operation: "disabled" });
    }
    yield* captureTarget("foreground");
  });

  const captureFromShortcut = Effect.gen(function* () {
    if (shortcutSuppressed) return;
    shortcutVerified = true;
    const now = yield* Clock.currentTimeNanos;
    if (lastShortcutAt !== undefined && now - lastShortcutAt < SHORTCUT_COOLDOWN_NS) return;
    lastShortcutAt = now;
    yield* capture;
  }).pipe(Effect.withSpan("desktop.windowCapture.shortcutActivated"));
  const onShortcut = () => runPromise(captureFromShortcut).catch(() => undefined);

  const checkShortcut = Effect.fn("desktop.windowCapture.checkShortcut")(function* (
    shortcut: WindowCaptureShortcut,
  ) {
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return { available: false, message: "Window capture is not supported on this platform." };
    }
    if (mode === "portal" && niriSocketPath()) {
      return {
        available: false,
        message: "Configure the capture shortcut in your Niri config, not in T3 Code.",
      };
    }
    if (mode === "portal" && isHyprlandCaptureSession()) {
      return {
        available: false,
        message: "Change the capture binding in your Hyprland config, then save it.",
      };
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
      return yield* Effect.try(() => portalShortcutTrigger(shortcut)).pipe(
        Effect.match({
          onSuccess: () => ({
            available: true,
            message: "Your desktop will confirm this shortcut when you save it.",
          }),
          onFailure: (error) => ({
            available: false,
            message: error.cause instanceof Error ? error.cause.message : "Unsupported shortcut.",
          }),
        }),
      );
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
    forceShortcut = false,
  ) {
    const previousSettings = yield* Ref.get(settingsRef);
    yield* Ref.set(settingsRef, settings);

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
    // Cosmetic capture preferences must not tear down an approved portal session.
    if (
      !forceShortcut &&
      portalShortcut &&
      settings.windowCaptureEnabled &&
      previousSettings.windowCaptureEnabled &&
      (isHyprlandCaptureSession() ||
        (!isModifierPairShortcut(shortcut) &&
          !isModifierPairShortcut(previousSettings.windowCaptureShortcut) &&
          toElectronAccelerator(shortcut) ===
            toElectronAccelerator(previousSettings.windowCaptureShortcut)))
    ) {
      yield* Ref.update(stateRef, (state) => ({ ...state, shortcut }));
      return;
    }
    releaseShortcut();
    shortcutVerified = false;
    const generation = shortcutGeneration;
    const onCurrentShortcut = () => {
      if (generation === shortcutGeneration) return onShortcut();
      return Promise.resolve();
    };
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
      (environment.platform === "darwin"
        ? currentMacWindowCapturePermissionMessage(settings.windowCaptureIncludeAccessibility)
        : null);
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
    if (mode === "portal" && niriSocketPath()) {
      const registered = yield* Effect.tryPromise(() =>
        startNiriCaptureShortcut(linuxAppId, onCurrentShortcut, () => {
          void runPromise(
            setShortcutFailure("The Niri capture endpoint disconnected. Restart T3 Code."),
          ).catch(() => undefined);
        }),
      ).pipe(
        Effect.tap((stop) =>
          Effect.sync(() => {
            stopShiftShortcut = stop;
          }),
        ),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* Ref.set(stateRef, {
        mode,
        linuxBackend: "niri",
        shortcut,
        shortcutRegistered: false,
        shortcutBinding: niriCaptureBinding(linuxAppId),
        shortcutConfigPath: niriCaptureConfigPath(),
        shortcutActionRegistered: registered,
        shortcutMessage: registered
          ? "Set up the shortcut to add it to your Niri config."
          : "Could not start the Niri capture endpoint. Another T3 Code instance may be using it.",
        message: null,
      });
      return;
    }
    const hyprland = mode === "portal" && isHyprlandCaptureSession();
    if (mode === "portal" && isModifierPairShortcut(shortcut) && !hyprland) {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        shortcutMessage: WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE,
        message: null,
      });
      return;
    }
    if (mode === "portal" && (!isModifierPairShortcut(shortcut) || hyprland)) {
      yield* Ref.set(stateRef, {
        mode,
        shortcut,
        shortcutRegistered: false,
        shortcutMessage: null,
        message: null,
      });
      yield* Effect.try(
        () =>
          new PortalCaptureShortcut(
            linuxAppId,
            isModifierPairShortcut(shortcut)
              ? {
                  key: "2",
                  ctrlKey: true,
                  modKey: false,
                  altKey: false,
                  shiftKey: true,
                  metaKey: false,
                }
              : shortcut,
            onCurrentShortcut,
            () => {
              if (generation !== shortcutGeneration) return;
              shortcutVerified = false;
              void runPromise(
                desktopWindow.dispatchMenuAction("window-capture-shortcut-changed"),
              ).catch(() => undefined);
            },
            undefined,
            hyprland,
          ),
      ).pipe(
        Effect.tap((registration) =>
          Effect.sync(() => {
            portalShortcut = registration;
          }),
        ),
        Effect.catch((error) =>
          Ref.update(stateRef, (state) => ({
            ...state,
            shortcutMessage:
              error.cause instanceof Error
                ? error.cause.message
                : "Could not connect to your desktop's shortcut service.",
          })),
        ),
      );
      return;
    }

    let registered = false;
    if (isModifierPairShortcut(shortcut)) {
      registered = yield* Effect.tryPromise(() =>
        startPairShortcutProcess(
          windowCaptureShortcutModifierPair(shortcut),
          onCurrentShortcut,
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
      registered = Electron.globalShortcut.register(accelerator, onCurrentShortcut);
      if (registered) registeredAccelerator = accelerator;
    }

    yield* Ref.set(stateRef, {
      mode,
      shortcut,
      shortcutRegistered: registered,
      message: null,
      shortcutMessage: registered
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

  const requestPermissions = (includeAccessibility: boolean) =>
    configurationMutex.withPermits(1)(
      environment.platform === "darwin"
        ? Effect.promise(() => requestMacWindowCapturePermissions(includeAccessibility)).pipe(
            Effect.asVoid,
          )
        : Effect.void,
    );

  const setup = Effect.fn("desktop.windowCapture.setup")(function* (
    action: DesktopWindowCaptureSetupAction,
  ) {
    if (action === "install-kde-helper" || action === "remove-kde-helper") {
      if (captureMode(environment.platform) !== "portal" || !isKdeCaptureSession())
        return yield* new DesktopWindowCaptureSetupError({
          action,
          reason: "unsupported-session",
        });
      yield* Effect.tryPromise({
        try: () => new KdeCaptureSetup(kdeCapturePaths).perform(action),
        catch: (error) =>
          new DesktopWindowCaptureSetupError({
            action,
            reason: "setup-failed",
            cause: error,
          }),
      });
    } else if (action === "install-hyprland-helper" || action === "remove-hyprland-helper") {
      if (captureMode(environment.platform) !== "portal" || !isHyprlandCaptureSession())
        return yield* new DesktopWindowCaptureSetupError({
          action,
          reason: "unsupported-session",
        });
      yield* Effect.tryPromise({
        try: () => new HyprlandCaptureSetup(hyprlandCapturePaths).perform(action),
        catch: (error) =>
          new DesktopWindowCaptureSetupError({
            action,
            reason: "setup-failed",
            cause: error,
          }),
      });
    } else if (action !== "retry-shortcut") {
      if (!hasGnomeSetup())
        return yield* new DesktopWindowCaptureSetupError({
          action,
          reason: "unsupported-session",
        });
      yield* Effect.tryPromise({
        try: async () => {
          const setup = new GnomeCaptureSetup(gnomeSetupPaths);
          try {
            await setup.perform(action);
          } finally {
            setup.close();
          }
        },
        catch: (error) =>
          new DesktopWindowCaptureSetupError({
            action,
            reason: "setup-failed",
            cause: error,
          }),
      });
    }
    if (action === "retry-shortcut") {
      const currentPortal = portalShortcut;
      if (currentPortal?.hasSession && !currentPortal.state.shortcutPending) {
        yield* Effect.tryPromise(() => currentPortal.configure()).pipe(
          Effect.mapError(
            (error) =>
              new DesktopWindowCaptureSetupError({
                action,
                reason: "shortcut-permissions",
                cause: error.cause,
              }),
          ),
        );
      } else yield* applySettings(yield* Ref.get(settingsRef), null, true);
    }
  }, configurationMutex.withPermits(1));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseShortcut();
      flash.dispose();
      transition.dispose();
      closeLinuxFeedback();
    }),
  );

  const configDesktop = Effect.fn("desktop.windowCapture.configDesktop")(function* (
    action: "preview-config" | "apply-config",
  ) {
    if (captureMode(environment.platform) === "portal") {
      if (niriSocketPath()) return "niri" as const;
      if (isHyprlandCaptureSession()) return "hyprland" as const;
    }
    return yield* new DesktopWindowCaptureSetupError({
      action,
      reason: "unsupported-session",
    });
  });
  const previewConfig = Effect.fn("desktop.windowCapture.previewConfig")(function* (
    request: DesktopCaptureConfigRequest,
    selectedPath?: string,
  ) {
    const desktop = yield* configDesktop("preview-config");
    return yield* Effect.tryPromise({
      try: async () => {
        const configPath =
          selectedPath ??
          (desktop === "niri"
            ? niriCaptureConfigPath()
            : (await hyprlandCaptureShortcut(linuxAppId)).shortcutConfigPath);
        return shortcutConfig.preview({ desktop, path: configPath, appId: linuxAppId }, request);
      },
      catch: (cause) =>
        new DesktopWindowCaptureSetupError({
          action: "preview-config",
          reason: "setup-failed",
          cause,
        }),
    });
  });
  const applyConfig = Effect.fn("desktop.windowCapture.applyConfig")(function* (previewId: string) {
    const desktop = yield* configDesktop("apply-config");
    const result = yield* Effect.tryPromise({
      try: () => shortcutConfig.apply(previewId, desktop),
      catch: (cause) =>
        new DesktopWindowCaptureSetupError({
          action: "apply-config",
          reason: "setup-failed",
          cause,
        }),
    });
    if (result.backupPath) shortcutVerified = false;
    return result;
  });

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
    setup,
    previewConfig,
    applyConfig,
    state: Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.mode === "portal"
          ? Effect.tryPromise(async () => {
              const { getLinuxCaptureSupport } = await import("./LinuxWindowCapture.ts");
              return getLinuxCaptureSupport(linuxAppId);
            }).pipe(
              Effect.map((support) => ({ ...state, ...support })),
              Effect.catch((error) =>
                Effect.succeed({
                  ...state,
                  message:
                    error.cause instanceof Error
                      ? error.cause.message
                      : "Could not check desktop capture support. Check your desktop session and try again.",
                }),
              ),
            )
          : Effect.succeed(state),
      ),
      Effect.flatMap((state) =>
        Effect.gen(function* () {
          // Keep the session identity available even when its capability probe fails.
          const linuxDesktop =
            state.mode === "portal"
              ? process.env.XDG_CURRENT_DESKTOP?.toLowerCase()
                  .split(":")
                  .find(
                    (name) =>
                      name === "gnome" || name === "kde" || name === "niri" || name === "hyprland",
                  )
              : undefined;
          const gnomeExtension = hasGnomeSetup()
            ? yield* Effect.promise(async () => {
                const setup = new GnomeCaptureSetup(gnomeSetupPaths);
                try {
                  return await setup.state();
                } finally {
                  setup.close();
                }
              })
            : undefined;
          const kdeHelper =
            state.linuxBackend === "kde"
              ? yield* Effect.promise(() => new KdeCaptureSetup(kdeCapturePaths).state())
              : undefined;
          const hyprlandHelper =
            state.linuxBackend === "hyprland"
              ? yield* Effect.promise(() => new HyprlandCaptureSetup(hyprlandCapturePaths).state())
              : undefined;
          const hyprlandShortcut =
            state.linuxBackend === "hyprland"
              ? yield* Effect.promise(() => hyprlandCaptureShortcut(linuxAppId))
              : undefined;
          return {
            ...state,
            ...portalShortcut?.state,
            ...(linuxDesktop ? { linuxDesktop } : {}),
            ...(gnomeExtension ? { gnomeExtension } : {}),
            ...(hyprlandHelper
              ? {
                  hyprlandHelper,
                  linuxFeedbackAvailable:
                    hyprlandHelper.status === "ready" && hyprlandHelper.feedbackAvailable === true,
                }
              : {}),
            ...hyprlandShortcut,
            ...(state.linuxBackend === "niri"
              ? { shortcutConfigPath: niriCaptureConfigPath() }
              : {}),
            ...(kdeHelper
              ? {
                  kdeHelper,
                  linuxFeedbackAvailable:
                    kdeHelper.status === "ready" && kdeHelper.feedbackAvailable === true,
                }
              : {}),
            shortcutVerified,
          };
        }),
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
