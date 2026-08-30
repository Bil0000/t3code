import { describe, expect, it } from "vite-plus/test";

import {
  beginWindowCaptureAnimation,
  finishWindowCaptureAnimation,
  getPendingWindowCaptureAnimations,
  subscribeToPendingWindowCaptureAnimations,
} from "./windowCaptureAnimation";

describe("window capture animation", () => {
  it("publishes pending animation changes", () => {
    const changes: Array<ReadonlySet<string>> = [];
    const unsubscribe = subscribeToPendingWindowCaptureAnimations(() => {
      changes.push(getPendingWindowCaptureAnimations());
    });

    beginWindowCaptureAnimation("capture-1");
    finishWindowCaptureAnimation("capture-1");
    unsubscribe();

    expect([...changes[0]!]).toEqual(["capture-1"]);
    expect(changes[1]?.size).toBe(0);
  });
});
