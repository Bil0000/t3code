export type WindowCaptureSpringRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type WindowCaptureSpring = {
  readonly response: number;
  readonly dampingFraction: number;
  readonly durationMs: number;
  readonly samples: ReadonlyArray<{
    readonly offset: number;
    readonly progress: number;
  }>;
};

const RESPONSE_DISTANCE_SCALER = -0.000_355_460_092_594_843_7;
const RESPONSE_DISTANCE_WEIGHT = -0.29;
const RESPONSE_BASE = 0.57;
const SETTLING_RESPONSE_COUNT = 3;
const SAMPLE_RATE_HZ = 120;

export const WINDOW_CAPTURE_SPRING_DAMPING_FRACTION = 0.73;

function center(rect: WindowCaptureSpringRect): { readonly x: number; readonly y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function windowCaptureSpringResponse(
  source: WindowCaptureSpringRect,
  target: WindowCaptureSpringRect,
): number {
  const sourceCenter = center(source);
  const targetCenter = center(target);
  const distance = Math.hypot(sourceCenter.x - targetCenter.x, sourceCenter.y - targetCenter.y);
  return Math.exp(distance * RESPONSE_DISTANCE_SCALER) * RESPONSE_DISTANCE_WEIGHT + RESPONSE_BASE;
}

export function windowCaptureSpringProgress(
  elapsedSeconds: number,
  response: number,
  dampingFraction = WINDOW_CAPTURE_SPRING_DAMPING_FRACTION,
): number {
  if (elapsedSeconds <= 0) return 0;
  const angularFrequency = (2 * Math.PI) / response;
  const dampingComplement = Math.sqrt(1 - dampingFraction * dampingFraction);
  const dampedAngularFrequency = angularFrequency * dampingComplement;
  const decay = Math.exp(-dampingFraction * angularFrequency * elapsedSeconds);
  const displacement =
    Math.cos(dampedAngularFrequency * elapsedSeconds) +
    (dampingFraction / dampingComplement) * Math.sin(dampedAngularFrequency * elapsedSeconds);
  return 1 - decay * displacement;
}

export function windowCaptureSpring(
  source: WindowCaptureSpringRect,
  target: WindowCaptureSpringRect,
): WindowCaptureSpring {
  const response = windowCaptureSpringResponse(source, target);
  const durationSeconds = SETTLING_RESPONSE_COUNT * response;
  const sampleCount = Math.ceil(durationSeconds * SAMPLE_RATE_HZ);
  const samples = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    return {
      offset,
      progress:
        index === sampleCount ? 1 : windowCaptureSpringProgress(offset * durationSeconds, response),
    };
  });
  return {
    response,
    dampingFraction: WINDOW_CAPTURE_SPRING_DAMPING_FRACTION,
    durationMs: durationSeconds * 1_000,
    samples,
  };
}
