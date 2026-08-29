import { assert, it } from "@effect/vitest";

import { analyzeWindowCaptureAnimation } from "./WindowCaptureAnimationAnalysis.ts";
import { windowCaptureSpring } from "./WindowCaptureSpring.ts";

it("accepts the Appshots spring with an exact handoff", () => {
  const source = { x: 20, y: 30, width: 900, height: 600 };
  const target = { x: 300, y: 500, width: 208, height: 112 };
  const spring = windowCaptureSpring(source, target);
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const samples = spring.samples.map(({ offset, progress }) => {
    const width = source.width + (target.width - source.width) * progress;
    const height = source.height + (target.height - source.height) * progress;
    const centerX = sourceCenter.x + (targetCenter.x - sourceCenter.x) * progress;
    const centerY = sourceCenter.y + (targetCenter.y - sourceCenter.y) * progress;
    return {
      elapsedMs: spring.durationMs * offset,
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      detailsOpacity: Math.min(1, progress),
      flashOpacity: Math.max(0, 1 - progress),
    };
  });

  const analysis = analyzeWindowCaptureAnimation(
    {
      source,
      target,
      spring,
      samples,
    },
    target,
    { expectFlash: true, frameBudgetMs: 1_000 / 120 },
  );

  assert.isTrue(analysis.passed, analysis.issues.join("\n"));
  assert.isAtMost(analysis.metrics.sampleGapP95Ms, 1_000 / 120 + 0.01);
  assert.strictEqual(analysis.metrics.flashPeakOpacity, 1);
});

it("rejects a missed flash and a long compositor stall", () => {
  const source = { x: 20, y: 30, width: 900, height: 600 };
  const target = { x: 300, y: 500, width: 208, height: 112 };
  const spring = windowCaptureSpring(source, target);
  const samples = spring.samples.map(({ offset, progress }, index) => ({
    elapsedMs: spring.durationMs * offset + (index > 10 ? 100 : 0),
    x: source.x + (target.x - source.x) * progress,
    y: source.y + (target.y - source.y) * progress,
    width: source.width + (target.width - source.width) * progress,
    height: source.height + (target.height - source.height) * progress,
    detailsOpacity: 0,
    flashOpacity: 0,
  }));
  const analysis = analyzeWindowCaptureAnimation({ source, target, spring, samples }, target, {
    expectFlash: true,
    frameBudgetMs: 1_000 / 120,
  });

  assert.include(analysis.issues, "the animation misses its frame budget");
  assert.include(analysis.issues, "the capture flash is not visible at the start of the flight");
});

it("rejects a late start and a snapped handoff", () => {
  const source = { x: 0, y: 0, width: 900, height: 600 };
  const target = { x: 300, y: 500, width: 208, height: 112 };
  const samples = [
    { elapsedMs: 0, ...source, detailsOpacity: 0, flashOpacity: 1 },
    { elapsedMs: 100, ...source, detailsOpacity: 0, flashOpacity: 0.5 },
    { elapsedMs: 116, ...target, detailsOpacity: 1, flashOpacity: 0 },
  ];

  const analysis = analyzeWindowCaptureAnimation(
    { source, target, samples },
    { ...target, y: target.y + 38 },
  );

  assert.isFalse(analysis.passed);
  assert.include(
    analysis.issues,
    "the screenshot waits too long before moving toward the composer",
  );
  assert.include(analysis.issues, "a single frame covers more than 22% of the flight path");
  assert.include(
    analysis.issues,
    "the native card and the DOM attachment do not share the same final rectangle",
  );
});
