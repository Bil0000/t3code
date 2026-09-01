import type { DesktopBridge } from "@t3tools/contracts";

const WINDOW_CAPTURE_FOCUS_EVENT = "t3code:focus-composer";

export function dispatchWindowCaptureComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WINDOW_CAPTURE_FOCUS_EVENT));
}

export function subscribeWindowCaptureComposerFocus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(WINDOW_CAPTURE_FOCUS_EVENT, listener);
  return () => window.removeEventListener(WINDOW_CAPTURE_FOCUS_EVENT, listener);
}

type WindowCaptureMethods =
  | "requestWindowCapturePermissions"
  | "getWindowCaptureState"
  | "checkWindowCaptureShortcut"
  | "setWindowCaptureShortcutSuppressed"
  | "captureWindow"
  | "listPendingWindowCaptures"
  | "readWindowCapture"
  | "acknowledgeWindowCapture";

export type DesktopWindowCaptureBridge = DesktopBridge &
  Required<Pick<DesktopBridge, WindowCaptureMethods>>;

export function getDesktopWindowCaptureBridge(): DesktopWindowCaptureBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (
    typeof bridge?.requestWindowCapturePermissions !== "function" ||
    typeof bridge?.getWindowCaptureState !== "function" ||
    typeof bridge.checkWindowCaptureShortcut !== "function" ||
    typeof bridge.setWindowCaptureShortcutSuppressed !== "function" ||
    typeof bridge.captureWindow !== "function" ||
    typeof bridge.listPendingWindowCaptures !== "function" ||
    typeof bridge.readWindowCapture !== "function" ||
    typeof bridge.acknowledgeWindowCapture !== "function"
  ) {
    return undefined;
  }

  return bridge as DesktopWindowCaptureBridge;
}
