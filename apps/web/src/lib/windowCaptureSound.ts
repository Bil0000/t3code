import type { WindowCaptureSound } from "@t3tools/contracts";

import windowCaptureSoundUrl from "../assets/window-capture-up-pop.wav?url";

export function playWindowCaptureSound(sound: WindowCaptureSound): void {
  if (sound === "soft-pop") {
    const audio = new Audio(windowCaptureSoundUrl);
    audio.preload = "auto";
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
    return;
  }

  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  void context.resume().then(
    () => {
      const now = context.currentTime;
      const noiseBuffer = context.createBuffer(1, context.sampleRate * 0.05, context.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.random() * 2 - 1;
      }

      const click = (at: number, frequency: number, peak: number, duration: number) => {
        const source = context.createBufferSource();
        source.buffer = noiseBuffer;
        const filter = context.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(frequency, at);
        filter.Q.setValueAtTime(1.4, at);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        source.connect(filter);
        filter.connect(gain);
        gain.connect(context.destination);
        source.start(at);
        source.stop(at + duration);
        return source;
      };

      click(now, 2_400, 0.5, 0.03);
      const shutter = click(now + 0.075, 3_600, 0.85, 0.045);
      shutter.addEventListener("ended", () => void context.close(), { once: true });
    },
    () => void context.close(),
  );
}
