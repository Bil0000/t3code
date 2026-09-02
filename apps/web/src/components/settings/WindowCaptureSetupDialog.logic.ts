import type { DesktopWindowCaptureState } from "@t3tools/contracts";

export type CaptureSetupStep = "access" | "shortcut";

export function captureSetupDesktopName(state: DesktopWindowCaptureState): string | undefined {
  if (state.mode !== "portal") return undefined;
  const desktop = state.linuxDesktop ?? captureSetupBackend(state);
  switch (desktop) {
    case "gnome":
      return "GNOME";
    case "kde":
      return "KDE Plasma";
    case "niri":
      return "Niri";
    default:
      return undefined;
  }
}

export function captureSetupBackend(state: DesktopWindowCaptureState) {
  if (state.mode !== "portal") return "direct";
  if (state.linuxBackend === "niri") return "niri";
  if (state.linuxBackend === "kde") return "kde";
  if (state.linuxBackend === "screenshot-portal") return "portal";
  if (state.linuxBackend === "picker" && state.gnomeExtension?.status === "unsupported")
    return "picker";
  if (state.linuxBackend === "gnome-extension" || state.gnomeExtension) return "gnome";
  return "picker";
}

export function captureSetupAccessReady(state: DesktopWindowCaptureState): boolean {
  if (state.mode === "unavailable" || state.message) return false;
  if (captureSetupBackend(state) === "gnome")
    return state.gnomeExtension?.status === "enabled" && state.linuxBackend === "gnome-extension";
  if (captureSetupBackend(state) === "kde") return state.kdeHelper?.status === "ready";
  return true;
}

export function captureSetupCheckMessage(state: DesktopWindowCaptureState): string {
  const gnome = captureSetupBackend(state) === "gnome";
  if (
    state.message ||
    (gnome && state.gnomeExtension?.status === "error") ||
    state.kdeHelper?.status === "error"
  )
    return "Couldn't confirm capture access. See the details above.";
  if (captureSetupBackend(state) === "picker")
    return "Checked — manual capture is available. You'll choose a window each time.";
  if (gnome && state.gnomeExtension?.status === "restart-required")
    return "Checked — sign out and back in to continue.";
  return captureSetupAccessReady(state)
    ? "Checked — capture access is ready."
    : "Checked — finish the step above to continue.";
}

export function captureSetupShortcutReady(
  state: DesktopWindowCaptureState,
  unsaved: boolean,
): boolean {
  if (unsaved || !captureSetupAccessReady(state)) return false;
  return state.linuxBackend === "niri"
    ? Boolean(state.shortcutBinding)
    : state.shortcutRegistered || Boolean(state.shortcutPending);
}

export function captureSetupInitialStep(
  state: DesktopWindowCaptureState,
  requested: CaptureSetupStep | "resume" = "resume",
): CaptureSetupStep {
  if (!captureSetupAccessReady(state)) return "access";
  if (requested === "resume") {
    // A disabled native backend hasn't checked system permissions yet. A picker
    // still needs its explanation; neither is proof of active-window access.
    if (
      (state.mode === "direct" && !state.shortcutRegistered) ||
      captureSetupBackend(state) === "picker"
    )
      return "access";
    return "shortcut";
  }
  return requested;
}

export function captureSetupShouldDisableOnClose(wasEnabled: boolean, completed: boolean): boolean {
  return !wasEnabled && !completed;
}
