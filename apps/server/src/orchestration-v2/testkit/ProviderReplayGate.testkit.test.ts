import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

describe("ProviderReplayGate", () => {
  it("waits for the matching frame before releasing it", async () => {
    const gate = makeProviderReplayGate(["held-frame"]);
    let reached = false;
    const waiting = gate.waitUntilReached("held-frame").then((value) => {
      reached = value;
    });
    await gate.beforeEmit("other-frame");
    expect(reached).toBe(false);

    const emitting = gate.beforeEmit("held-frame");
    await waiting;
    expect(reached).toBe(true);
    expect(await gate.waitUntilReached("held-frame")).toBe(true);
    expect(await gate.waitUntilReached("unknown-frame")).toBe(false);
    expect(gate.release("held-frame")).toBe(true);
    await emitting;
  });

  it("stops waiting when the replay consumer is interrupted", async () => {
    const label = "held-frame";
    const gate = makeProviderReplayGate([label]);
    const controller = new AbortController();
    const waiting = gate.beforeEmit(label, controller.signal);

    expect(gate.hasReached(label)).toBe(true);
    controller.abort();
    await waiting;
    expect(gate.release(label)).toBe(true);
  });
});
