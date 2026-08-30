type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const DISTANCE_SCALER = -0.000_355_460_092_594_843_7;
const DAMPING = 0.73;
const SAMPLE_RATE_HZ = 120;

export function windowCaptureSpring(source: Rect, target: Rect) {
  const distance = Math.hypot(
    source.x + source.width / 2 - target.x - target.width / 2,
    source.y + source.height / 2 - target.y - target.height / 2,
  );
  const response = Math.exp(distance * DISTANCE_SCALER) * -0.29 + 0.57;
  const durationSeconds = response * 3;
  const sampleCount = Math.ceil(durationSeconds * SAMPLE_RATE_HZ);
  const angularFrequency = (2 * Math.PI) / response;
  const dampingComplement = Math.sqrt(1 - DAMPING * DAMPING);
  const dampedAngularFrequency = angularFrequency * dampingComplement;
  const samples = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const elapsed = offset * durationSeconds;
    const decay = Math.exp(-DAMPING * angularFrequency * elapsed);
    const displacement =
      Math.cos(dampedAngularFrequency * elapsed) +
      (DAMPING / dampingComplement) * Math.sin(dampedAngularFrequency * elapsed);
    return { offset, progress: index === sampleCount ? 1 : 1 - decay * displacement };
  });
  return { response, durationMs: durationSeconds * 1_000, samples };
}

export type WindowCaptureSpring = ReturnType<typeof windowCaptureSpring>;
