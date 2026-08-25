import { describe, expect, it } from "vite-plus/test";

import {
  consumeWindowCaptureAnimation,
  hasWindowCaptureAnimation,
  markWindowCaptureAnimation,
} from "./windowCaptureAnimation";

describe("window capture animation", () => {
  it("runs once for a newly attached file", () => {
    const file = new File(["capture"], "capture.png", { type: "image/png" });

    expect(hasWindowCaptureAnimation(file)).toBe(false);
    markWindowCaptureAnimation(file);
    expect(hasWindowCaptureAnimation(file)).toBe(true);
    consumeWindowCaptureAnimation(file);
    expect(hasWindowCaptureAnimation(file)).toBe(false);
  });
});
