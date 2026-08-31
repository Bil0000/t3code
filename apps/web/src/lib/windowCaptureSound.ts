import type { WindowCaptureSound } from "@t3tools/contracts";

import windowCaptureClickUrl from "../assets/window-capture-click.mp3?url";
import windowCaptureWhooshUrl from "../assets/window-capture-whoosh.mp3?url";

export function playWindowCaptureSound(sound: WindowCaptureSound): void {
  const audio = new Audio(sound === "soft-pop" ? windowCaptureWhooshUrl : windowCaptureClickUrl);
  audio.preload = "auto";
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}
