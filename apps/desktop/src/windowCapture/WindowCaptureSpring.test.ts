import { assert, it } from "@effect/vitest";

import { windowCaptureSpring } from "./WindowCaptureSpring.ts";

it("uses a distance-aware spring that overshoots and settles", () => {
  const spring = windowCaptureSpring(
    { x: 0, y: 0, width: 200, height: 100 },
    { x: 1_000, y: 0, width: 200, height: 100 },
  );

  assert.closeTo(spring.response, 0.366_753_235_316_336, 1e-12);
  assert.closeTo(spring.durationMs, spring.response * 3_000, 1e-9);
  assert.strictEqual(spring.samples[0]?.progress, 0);
  assert.strictEqual(spring.samples.at(-1)?.progress, 1);
  assert.isTrue(spring.samples.some((sample) => sample.progress > 1.03));
});
