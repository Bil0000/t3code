import type { WindowCaptureSource } from "@t3tools/contracts";

import { getDesktopWindowCaptureBridge } from "./desktopWindowCapture";

let pendingAnimations: ReadonlySet<string> = new Set();
const destinationRequests = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function beginWindowCaptureAnimation(id: string): void {
  if (pendingAnimations.has(id)) return;
  pendingAnimations = new Set(pendingAnimations).add(id);
  emitChange();
}

export function finishWindowCaptureAnimation(id: string): void {
  if (!pendingAnimations.has(id)) return;
  const next = new Set(pendingAnimations);
  next.delete(id);
  pendingAnimations = next;
  destinationRequests.delete(id);
  emitChange();
}

export function dismissWindowCaptureAnimation(id: string): void {
  if (!pendingAnimations.has(id)) return;
  finishWindowCaptureAnimation(id);
  void getDesktopWindowCaptureBridge()
    ?.dismissWindowCaptureAnimation?.(id)
    .catch(() => undefined);
}

export function dismissAllWindowCaptureAnimations(): void {
  if (pendingAnimations.size === 0) return;
  const ids = [...pendingAnimations];
  pendingAnimations = new Set();
  destinationRequests.clear();
  emitChange();
  const dismiss = getDesktopWindowCaptureBridge()?.dismissWindowCaptureAnimation;
  if (!dismiss) return;
  for (const id of ids) void dismiss(id).catch(() => undefined);
}

export function getPendingWindowCaptureAnimations(): ReadonlySet<string> {
  return pendingAnimations;
}

export function subscribeToPendingWindowCaptureAnimations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setWindowCaptureAnimationDestination(
  id: string,
  target: HTMLElement,
  source: WindowCaptureSource,
): void {
  if (!target.isConnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const bridge = getDesktopWindowCaptureBridge();
  if (!bridge?.setWindowCaptureAnimationDestination) return;
  const frame = target.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) return;
  const style = window.getComputedStyle(target);
  const borderWidth = Number.parseFloat(style.borderTopWidth);
  const cornerRadius = Number.parseFloat(style.borderTopLeftRadius);
  const request = bridge
    .setWindowCaptureAnimationDestination({
      id,
      viewportFrame: {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderWidth: Number.isFinite(borderWidth) ? borderWidth : 0,
      cornerRadius: Number.isFinite(cornerRadius) ? cornerRadius : 0,
      details: {
        appName: source.appName,
        windowTitle: source.windowTitle,
        ...(source.appIconDataUrl ? { appIconDataUrl: source.appIconDataUrl } : {}),
      },
    })
    .catch(() => undefined);
  destinationRequests.set(id, request);
}

export async function waitForWindowCaptureAnimationDestination(id: string): Promise<void> {
  await destinationRequests.get(id);
}
