import type { DesktopBridge } from "@t3tools/contracts";

type WindowCaptureMethods =
  | "getWindowCaptureState"
  | "captureWindow"
  | "listPendingWindowCaptures"
  | "readWindowCapture"
  | "acknowledgeWindowCapture";

export type DesktopWindowCaptureBridge = DesktopBridge &
  Required<Pick<DesktopBridge, WindowCaptureMethods>>;

export function getDesktopWindowCaptureBridge(): DesktopWindowCaptureBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (
    typeof bridge?.getWindowCaptureState !== "function" ||
    typeof bridge.captureWindow !== "function" ||
    typeof bridge.listPendingWindowCaptures !== "function" ||
    typeof bridge.readWindowCapture !== "function" ||
    typeof bridge.acknowledgeWindowCapture !== "function"
  ) {
    return undefined;
  }

  return bridge as DesktopWindowCaptureBridge;
}
