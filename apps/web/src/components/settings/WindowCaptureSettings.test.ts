import { describe, expect, it } from "vite-plus/test";

import { isWindowCaptureAvailable } from "./WindowCaptureSettings";

describe("isWindowCaptureAvailable", () => {
  it.each([
    [false, null, false],
    [true, null, false],
    [true, { mode: "unavailable" as const }, false],
    [true, { mode: "direct" as const }, true],
  ])("returns %s with %o as %s", (hasBridge, state, expected) => {
    expect(isWindowCaptureAvailable(hasBridge, state)).toBe(expected);
  });
});
