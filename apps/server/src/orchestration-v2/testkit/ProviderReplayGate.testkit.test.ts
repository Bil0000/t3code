import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

describe("ProviderReplayGate", () => {
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
  it("waits for replay arrival before releasing emission, including late waiters", async () => {
    const gate = makeProviderReplayGate(["held-frame"]);
    let reached = false;
    const waiting = gate.waitForReached("held-frame").then(() => {
      reached = true;
    });
    await Promise.resolve();
    expect(reached).toBe(false);
    const emission = gate.beforeEmit("held-frame");
    await waiting;
    expect(reached).toBe(true);
    await gate.waitForReached("held-frame");
    expect(gate.release("held-frame")).toBe(true);
    await emission;
    await expect(gate.waitForReached("missing-frame")).rejects.toThrow(
      "Unknown provider replay gate label",
    );
  });
});
