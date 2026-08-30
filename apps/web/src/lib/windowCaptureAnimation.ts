import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, WindowCaptureSource } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";
import { getDesktopWindowCaptureBridge } from "./desktopWindowCapture";

type WindowCaptureTarget = DraftId | ScopedThreadRef;

export type PendingWindowCaptureAnimation = {
  readonly id: string;
  readonly target: WindowCaptureTarget;
  readonly source?: WindowCaptureSource | undefined;
};

let pendingAnimations: ReadonlyArray<PendingWindowCaptureAnimation> = [];
const destinationRequests = new Map<string, Promise<void>>();
const destinationMountCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function targetKey(target: WindowCaptureTarget): string {
  return typeof target === "string" ? target.trim() : scopedThreadKey(target);
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function beginWindowCaptureAnimation(id: string, target: WindowCaptureTarget): void {
  if (pendingAnimations.some((capture) => capture.id === id)) return;
  destinationRequests.delete(id);
  pendingAnimations = [{ id, target }, ...pendingAnimations];
  emitChange();
}

export function finishWindowCaptureAnimation(id: string): void {
  const next = pendingAnimations.filter((capture) => capture.id !== id);
  destinationRequests.delete(id);
  destinationMountCounts.delete(id);
  if (next.length === pendingAnimations.length) return;
  pendingAnimations = next;
  emitChange();
}

export function updateWindowCaptureAnimationSource(id: string, source: WindowCaptureSource): void {
  const index = pendingAnimations.findIndex((capture) => capture.id === id);
  if (index < 0 || pendingAnimations[index]?.source === source) return;
  pendingAnimations = pendingAnimations.map((capture, captureIndex) =>
    captureIndex === index ? { ...capture, source } : capture,
  );
  emitChange();
}

function finishAllWindowCaptureAnimations(): void {
  const hadPendingAnimations = pendingAnimations.length > 0;
  pendingAnimations = [];
  destinationRequests.clear();
  destinationMountCounts.clear();
  if (hadPendingAnimations) emitChange();
}

export async function dismissWindowCaptureAnimation(id: string): Promise<void> {
  if (!pendingAnimations.some((capture) => capture.id === id)) return;
  finishWindowCaptureAnimation(id);
  const bridge = getDesktopWindowCaptureBridge();
  if (typeof bridge?.dismissWindowCaptureAnimation !== "function") return;
  await bridge.dismissWindowCaptureAnimation(id).catch(() => undefined);
}

export function dismissAllWindowCaptureAnimations(): void {
  const ids = pendingAnimations.map((capture) => capture.id);
  if (ids.length === 0) return;
  finishAllWindowCaptureAnimations();
  const bridge = getDesktopWindowCaptureBridge();
  if (typeof bridge?.dismissWindowCaptureAnimation !== "function") return;
  for (const id of ids) {
    void bridge.dismissWindowCaptureAnimation(id).catch(() => undefined);
  }
}

export function getPendingWindowCaptureAnimations(): ReadonlyArray<PendingWindowCaptureAnimation> {
  return pendingAnimations;
}

export function subscribeToPendingWindowCaptureAnimations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingWindowCaptureAnimationIdsForTarget(
  pending: ReadonlyArray<PendingWindowCaptureAnimation>,
  target: WindowCaptureTarget,
): ReadonlyArray<string> {
  const key = targetKey(target);
  return pending
    .filter((capture) => targetKey(capture.target) === key)
    .map((capture) => capture.id);
}

export function setWindowCaptureAnimationDestination(
  id: string,
  target: HTMLElement,
  source?: WindowCaptureSource,
): void {
  if (!target.isConnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const bridge = getDesktopWindowCaptureBridge();
  if (typeof bridge?.setWindowCaptureAnimationDestination !== "function") return;
  const frame = target.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) return;
  const style = window.getComputedStyle(target);
  const cornerRadius = Number.parseFloat(style.borderTopLeftRadius);
  const borderWidth = Number.parseFloat(style.borderTopWidth);
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
      ...(source
        ? {
            details: {
              appName: source.appName,
              windowTitle: source.windowTitle,
              ...(source.appIconDataUrl ? { appIconDataUrl: source.appIconDataUrl } : {}),
            },
          }
        : {}),
    })
    .catch(() => undefined);
  destinationRequests.set(id, request);
}

export async function waitForWindowCaptureAnimationDestination(id: string): Promise<void> {
  await destinationRequests.get(id);
}

export function scheduleWindowCaptureAnimationDestination(
  id: string,
  start: () => void,
): () => void {
  let active = true;
  destinationMountCounts.set(id, (destinationMountCounts.get(id) ?? 0) + 1);
  queueMicrotask(() => {
    if (!active) return;
    start();
  });
  return () => {
    if (!active) return;
    active = false;
    const remainingMounts = Math.max(0, (destinationMountCounts.get(id) ?? 1) - 1);
    if (remainingMounts === 0) destinationMountCounts.delete(id);
    else destinationMountCounts.set(id, remainingMounts);
    queueMicrotask(() => {
      if ((destinationMountCounts.get(id) ?? 0) > 0) return;
      if (!pendingAnimations.some((capture) => capture.id === id)) return;
      void dismissWindowCaptureAnimation(id);
    });
  };
}
