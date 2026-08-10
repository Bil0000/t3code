import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeQuitHoldHandler, QUIT_HOLD_DURATION_MS } from "./QuitHold.ts";
import type { QuitHoldKeyInput, QuitHoldState } from "./QuitHold.ts";

function makeInput(overrides: Partial<QuitHoldKeyInput>): QuitHoldKeyInput {
  return {
    type: "keyDown",
    key: "q",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

function makeHarness(options?: { enabled?: boolean; platform?: NodeJS.Platform }) {
  const notifications: Array<QuitHoldState> = [];
  const quit = vi.fn();
  const handler = makeQuitHoldHandler({
    platform: options?.platform ?? "darwin",
    isEnabled: () => Promise.resolve(options?.enabled ?? true),
    notify: (state) => notifications.push(state),
    quit,
  });
  const preventDefault = vi.fn();
  const send = async (input: QuitHoldKeyInput) => {
    handler({ preventDefault }, input);
    // Let the isEnabled promise settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { notifications, quit, preventDefault, send };
}

describe("makeQuitHoldHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the hint on a tap without quitting", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down"]);

    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("quits after the shortcut is held for the full duration", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ isAutoRepeat: true }));
    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS - 1);
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.quit).toHaveBeenCalledTimes(1);
    // Only one hint for the whole hold, despite auto-repeats.
    expect(harness.notifications).toEqual(["down"]);
  });

  it("cancels the hold when the modifier is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("quits immediately on a single press when disabled", async () => {
    const harness = makeHarness({ enabled: false });
    await harness.send(makeInput({}));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("ignores other shortcuts", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({ key: "w" }));
    await harness.send(makeInput({ shift: true }));
    await harness.send(makeInput({ meta: false }));
    expect(harness.preventDefault).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("uses control on non-mac platforms", async () => {
    const harness = makeHarness({ platform: "linux" });
    await harness.send(makeInput({ meta: false, control: true }));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });
});
