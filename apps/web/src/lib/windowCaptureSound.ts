import windowCaptureSoundUrl from "../assets/window-capture-up-pop.wav?url";

export function playWindowCaptureSound(): void {
  const sound = new Audio(windowCaptureSoundUrl);
  sound.preload = "auto";
  sound.currentTime = 0;
  void sound.play().catch(() => undefined);
}
