import { assert, describe, it } from "@effect/vitest";

import {
  WINDOW_CAPTURE_SPRING_DAMPING_FRACTION,
  windowCaptureSpring,
  windowCaptureSpringProgress,
  windowCaptureSpringResponse,
} from "./WindowCaptureSpring.ts";

describe("window capture spring", () => {
  it("matches the adaptive response used by Appshots", () => {
    const source = { x: 0, y: 0, width: 200, height: 100 };

    assert.closeTo(windowCaptureSpringResponse(source, source), 0.28, 1e-12);
    assert.closeTo(
      windowCaptureSpringResponse(source, { ...source, x: 1_000 }),
      0.366_753_235_316_336,
      1e-12,
    );
    assert.strictEqual(WINDOW_CAPTURE_SPRING_DAMPING_FRACTION, 0.73);
  });

  it("overshoots once and settles exactly on the destination", () => {
    const response = 0.35;
    const firstOvershootAt = response / (2 * Math.sqrt(1 - 0.73 ** 2));

    assert.isAbove(windowCaptureSpringProgress(firstOvershootAt, response), 1.03);

    const spring = windowCaptureSpring(
      { x: 0, y: 0, width: 900, height: 600 },
      { x: 300, y: 500, width: 208, height: 112 },
    );
    assert.closeTo(spring.durationMs, spring.response * 3_000, 1e-9);
    assert.strictEqual(spring.samples[0]?.progress, 0);
    assert.strictEqual(spring.samples.at(-1)?.progress, 1);
    assert.isTrue(spring.samples.some((sample) => sample.progress > 1.03));
  });
});
