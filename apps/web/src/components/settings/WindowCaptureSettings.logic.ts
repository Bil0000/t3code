import type {
  ClientSettingsPatch,
  DesktopWindowCaptureState,
  WindowCaptureSound,
} from "@t3tools/contracts";

export function windowCaptureStatus(
  state: DesktopWindowCaptureState | null,
  enabled: boolean,
): string {
  if (!state) return "Checking desktop support...";
  if (state.mode === "unavailable") return state.message ?? "Not supported on this platform.";
  if (!enabled) return "Turn this on to register the shortcut.";
  if (state.message) return state.message;
  if (!state.shortcutRegistered) return "The shortcut could not be registered.";
  if (state.mode !== "portal") return "Ready. The active window will be captured.";
  switch (state.linuxBackend) {
    case "screenshot-portal":
      return "Captures the active window through your desktop's Screenshot portal. Your desktop may ask for permission.";
    case "gnome-extension":
      return "Captures the active window through the T3 Code GNOME extension.";
    case "picker":
      return "Your desktop will show a window picker. On GNOME, enable the T3 Code Window Capture extension for active-window capture.";
    default:
      return "Active-window capture support could not be checked. Your desktop may show a window picker.";
  }
}

export type WindowCaptureSoundSelection = WindowCaptureSound | "off";

export function windowCaptureFeedbackUnavailableMessage(
  state: DesktopWindowCaptureState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  return state.linuxBackend === "gnome-extension"
    ? "Update the T3 Code GNOME extension and sign out and back in to enable capture effects."
    : "Capture effects on Wayland require the T3 Code GNOME extension.";
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
