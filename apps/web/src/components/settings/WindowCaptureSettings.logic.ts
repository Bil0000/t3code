import type {
  ClientSettingsPatch,
  DesktopWindowCaptureState,
  WindowCaptureSound,
} from "@t3tools/contracts";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
} from "./WindowCaptureSetupDialog.logic";

export function windowCaptureStatus(
  state: DesktopWindowCaptureState | null,
  enabled: boolean,
): string {
  if (!state) return "Checking desktop support...";
  if (state.mode === "unavailable") return state.message ?? "Not supported on this platform.";
  if (!enabled) return "Turn this on to set up window capture.";
  return windowCaptureSetupSummary(state, enabled);
}

export function windowCaptureSetupSummary(
  state: DesktopWindowCaptureState,
  enabled: boolean,
): string {
  if (state.message) return "Capture needs attention";
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return "Set up active-window capture";
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? "Check KDE capture access in setup"
      : "Install the KDE capture helper to continue";
  if (captureSetupBackend(state) === "picker")
    return "Manual capture only — you'll choose a window each time";
  if (!enabled) return "Enable capture to continue";
  if (state.shortcutPending) return "Waiting for shortcut permission";
  if (state.shortcutVerified) return "Ready to capture";
  if (state.linuxBackend === "niri" && state.shortcutBinding) return "Shortcut managed by Niri";
  if (state.shortcutRegistered) return state.shortcutLabel ? "Ready to capture" : "Shortcut saved";
  return "Finish shortcut setup";
}

export function windowCaptureShortcutStatus(
  state: DesktopWindowCaptureState | null,
): string | null {
  if (!state) return null;
  if (state.shortcutPending)
    return "Waiting for shortcut permission. Approve the desktop prompt if one appears.";
  if (state.shortcutLabel) return `Desktop shortcut: ${state.shortcutLabel}`;
  if (state.mode === "portal" && state.shortcutMessage) return state.shortcutMessage;
  return state.shortcutRegistered ? "Shortcut saved." : state.shortcutMessage;
}

export function windowCaptureSetupButtonLabel(state: DesktopWindowCaptureState | null): string {
  if (!state) return "Continue setup";
  if (captureSetupAccessReady(state)) return "Manage capture";
  const desktop = captureSetupDesktopName(state);
  return desktop ? `Set up ${desktop} capture` : "Continue setup";
}

export type WindowCaptureSoundSelection = WindowCaptureSound | "off";

export function windowCaptureFeedbackUnavailableMessage(
  state: DesktopWindowCaptureState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "niri")
    return "Window flash and flight animations are not supported on Niri.";
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? "This KDE Plasma version doesn't support capture effects. You can still capture windows."
      : "Install or update the KDE Plasma capture helper in setup to use window flash and flight animations.";
  return state.linuxBackend === "gnome-extension"
    ? "Update the T3 Code GNOME extension and sign out and back in to enable capture effects."
    : captureSetupBackend(state) === "gnome"
      ? "Finish installing and enabling the GNOME extension in capture setup to use effects."
      : "This capture method doesn't support window flash or flight animations.";
}

export function windowCaptureDescription(state: DesktopWindowCaptureState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? "Automatic capture isn't available on this desktop. You can still choose a window manually."
    : "Capture a window and attach it to your current draft.";
}

export function windowCaptureAccessibilityUnavailableMessage(
  state: DesktopWindowCaptureState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return "This capture method provides an image only. Accessibility text isn't available.";
  return undefined;
}

export function windowCaptureUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? "Update the desktop app to use window capture."
    : "Only available in the desktop app.";
}

export function windowCaptureSoundPatch(sound: WindowCaptureSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { windowCapturePlaySound: false }
    : { windowCapturePlaySound: true, windowCaptureSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
