const pendingWindowCaptureAnimations = new WeakSet<File>();

export function markWindowCaptureAnimation(file: File): void {
  pendingWindowCaptureAnimations.add(file);
}

export function hasWindowCaptureAnimation(file: File): boolean {
  return pendingWindowCaptureAnimations.has(file);
}

export function consumeWindowCaptureAnimation(file: File): void {
  pendingWindowCaptureAnimations.delete(file);
}
