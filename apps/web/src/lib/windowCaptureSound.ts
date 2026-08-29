import windowCaptureSoundUrl from "../assets/window-capture-up-pop.wav?url";

// CC0 foley sources: a DSLR shutter, gum-bubble pop, finger-and-hairbrush cork
// pop, and mouth-made water drop from freesound.org/s/87149, /s/253956,
// /s/622150, and /s/174718.
export function playWindowCaptureSound(): void {
  const sound = new Audio(windowCaptureSoundUrl);
  sound.preload = "auto";
  sound.currentTime = 0;
  void sound.play().catch(() => undefined);
}
