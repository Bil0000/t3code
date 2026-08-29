import { windowCaptureSpringProgress } from "./WindowCaptureSpring.ts";

export type WindowCaptureAnimationFrame = {
  readonly elapsedMs: number;
  readonly animationTimeMs?: number | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly detailsOpacity: number;
  readonly flashOpacity: number;
};

export type WindowCaptureAnimationRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type WindowCaptureAnimationTrace = {
  readonly source: WindowCaptureAnimationRect;
  readonly target: WindowCaptureAnimationRect;
  readonly spring?:
    | {
        readonly response: number;
        readonly dampingFraction: number;
        readonly durationMs: number;
      }
    | undefined;
  readonly samples: ReadonlyArray<WindowCaptureAnimationFrame>;
};

export type WindowCaptureAnimationAnalysis = {
  readonly passed: boolean;
  readonly issues: ReadonlyArray<string>;
  readonly metrics: {
    readonly sampleCount: number;
    readonly durationMs: number;
    readonly firstMotionMs: number | null;
    readonly finalRectErrorPx: number;
    readonly handoffRectErrorPx: number;
    readonly largestFrameTravelRatio: number;
    readonly largestSampleGapMs: number;
    readonly sampleGapP95Ms: number;
    readonly maxSpringProgressError: number;
    readonly flashPeakOpacity: number;
    readonly flashFirstVisibleMs: number | null;
    readonly landingMinScale: number;
    readonly landingMaxScaleAfterMin: number;
  };
};

function rectError(left: WindowCaptureAnimationRect, right: WindowCaptureAnimationRect): number {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

function center(rect: WindowCaptureAnimationRect): { readonly x: number; readonly y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function rectProgress(
  source: WindowCaptureAnimationRect,
  target: WindowCaptureAnimationRect,
  sample: WindowCaptureAnimationRect,
): number {
  const sourceValues = [source.x, source.y, source.width, source.height];
  const targetValues = [target.x, target.y, target.width, target.height];
  const sampleValues = [sample.x, sample.y, sample.width, sample.height];
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < sourceValues.length; index += 1) {
    const delta = (targetValues[index] ?? 0) - (sourceValues[index] ?? 0);
    numerator += ((sampleValues[index] ?? 0) - (sourceValues[index] ?? 0)) * delta;
    denominator += delta * delta;
  }
  return denominator === 0 ? 1 : numerator / denominator;
}

export function analyzeWindowCaptureAnimation(
  trace: WindowCaptureAnimationTrace,
  handoffTarget: WindowCaptureAnimationRect = trace.target,
  options: {
    readonly expectFlash?: boolean | undefined;
    readonly frameBudgetMs?: number | undefined;
  } = {},
): WindowCaptureAnimationAnalysis {
  const issues: Array<string> = [];
  const first = trace.samples[0];
  const last = trace.samples.at(-1);
  const durationMs = last?.elapsedMs ?? 0;
  const sourceCenter = center(trace.source);
  const targetCenter = center(trace.target);
  const totalTravel = Math.max(1, distance(sourceCenter, targetCenter));
  let firstMotionMs: number | null = null;
  let largestFrameTravelRatio = 0;
  let maxSpringProgressError = 0;
  const sampleGaps: Array<number> = [];

  for (let index = 0; index < trace.samples.length; index += 1) {
    const sample = trace.samples[index];
    if (!sample) continue;
    if (firstMotionMs === null && rectError(sample, trace.source) >= 2) {
      firstMotionMs = sample.elapsedMs;
    }
    if (trace.spring) {
      const elapsedMs = sample.animationTimeMs ?? sample.elapsedMs;
      maxSpringProgressError = Math.max(
        maxSpringProgressError,
        Math.abs(
          rectProgress(trace.source, trace.target, sample) -
            windowCaptureSpringProgress(
              elapsedMs / 1_000,
              trace.spring.response,
              trace.spring.dampingFraction,
            ),
        ),
      );
    }
    const previous = trace.samples[index - 1];
    if (!previous) continue;
    sampleGaps.push(sample.elapsedMs - previous.elapsedMs);
    largestFrameTravelRatio = Math.max(
      largestFrameTravelRatio,
      distance(center(previous), center(sample)) / totalTravel,
    );
  }

  const landingStart = trace.samples.findIndex(
    (sample) =>
      sample.width <= trace.target.width * 1.08 &&
      distance(center(sample), targetCenter) <= Math.max(12, totalTravel * 0.02),
  );
  const landingSamples = landingStart >= 0 ? trace.samples.slice(landingStart) : [];
  let landingMinScale = Number.POSITIVE_INFINITY;
  let landingMinIndex = -1;
  for (let index = 0; index < landingSamples.length; index += 1) {
    const sample = landingSamples[index];
    if (!sample) continue;
    const scale = sample.width / trace.target.width;
    if (scale < landingMinScale) {
      landingMinScale = scale;
      landingMinIndex = index;
    }
  }
  const landingMaxScaleAfterMin = landingSamples
    .slice(Math.max(0, landingMinIndex + 1))
    .reduce((maximum, sample) => Math.max(maximum, sample.width / trace.target.width), 0);
  const finalRectErrorPx = last ? rectError(last, trace.target) : Number.POSITIVE_INFINITY;
  const handoffRectErrorPx = last ? rectError(last, handoffTarget) : Number.POSITIVE_INFINITY;
  const sortedSampleGaps = sampleGaps.toSorted((left, right) => left - right);
  const largestSampleGapMs = sortedSampleGaps.at(-1) ?? 0;
  const sampleGapP95Ms =
    sortedSampleGaps[Math.min(sortedSampleGaps.length - 1, Math.floor(sampleGaps.length * 0.95))] ??
    0;
  const flashPeakOpacity = trace.samples.reduce(
    (peak, sample) => Math.max(peak, sample.flashOpacity),
    0,
  );
  const flashFirstVisibleMs =
    trace.samples.find((sample) => sample.flashOpacity >= 0.9)?.elapsedMs ?? null;

  if (trace.samples.length < 20) issues.push("fewer than 20 animation samples were recorded");
  if (!first || rectError(first, trace.source) > 1) {
    issues.push("the first sampled frame does not match the captured window");
  }
  if (firstMotionMs === null || firstMotionMs > 80) {
    issues.push("the screenshot waits too long before moving toward the composer");
  }
  if (!trace.spring && largestFrameTravelRatio > 0.22) {
    issues.push("a single frame covers more than 22% of the flight path");
  }
  if (trace.spring && maxSpringProgressError > 0.03) {
    issues.push("the sampled geometry diverges from the declared Appshots spring");
  }
  if (
    options.frameBudgetMs !== undefined &&
    (sampleGapP95Ms > options.frameBudgetMs * 1.5 || largestSampleGapMs > options.frameBudgetMs * 3)
  ) {
    issues.push("the animation misses its frame budget");
  }
  if (options.expectFlash && (flashPeakOpacity < 0.9 || flashFirstVisibleMs === null)) {
    issues.push("the capture flash is not visible at the start of the flight");
  }
  if (finalRectErrorPx > 0.75) {
    issues.push("the native card does not finish on its declared target");
  }
  if (handoffRectErrorPx > 0.75) {
    issues.push("the native card and the DOM attachment do not share the same final rectangle");
  }
  if (landingMinScale > 0.995) {
    issues.push("the landing does not include the requested compression bounce");
  }
  if (landingMaxScaleAfterMin < Math.min(0.995, landingMinScale + 0.02)) {
    issues.push("the landing does not rebound after compression");
  }

  return {
    passed: issues.length === 0,
    issues,
    metrics: {
      sampleCount: trace.samples.length,
      durationMs,
      firstMotionMs,
      finalRectErrorPx,
      handoffRectErrorPx,
      largestFrameTravelRatio,
      largestSampleGapMs,
      sampleGapP95Ms,
      maxSpringProgressError,
      flashPeakOpacity,
      flashFirstVisibleMs,
      landingMinScale,
      landingMaxScaleAfterMin,
    },
  };
}
