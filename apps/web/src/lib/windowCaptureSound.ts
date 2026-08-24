export function playWindowCaptureSound(): void {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const now = context.currentTime;
  const gain = context.createGain();
  const high = context.createOscillator();
  const low = context.createOscillator();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  high.type = "square";
  high.frequency.setValueAtTime(1_150, now);
  low.type = "sine";
  low.frequency.setValueAtTime(180, now);
  high.connect(gain);
  low.connect(gain);
  gain.connect(context.destination);
  high.start(now);
  low.start(now);
  high.stop(now + 0.09);
  low.stop(now + 0.09);
  high.addEventListener("ended", () => void context.close(), { once: true });
}
