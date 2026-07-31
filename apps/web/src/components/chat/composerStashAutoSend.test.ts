import { describe, expect, it } from "vite-plus/test";

import { shouldAutoSendStashedPrompt } from "./composerStashAutoSend";

const settledTurn = {
  enabled: true,
  hasStashedPrompt: true,
  wasWorking: true,
  isWorking: false,
  phase: "ready",
  hasComposerContent: false,
  sendBlocked: false,
} as const;

describe("shouldAutoSendStashedPrompt", () => {
  it("sends the next stashed prompt once the turn settles", () => {
    expect(shouldAutoSendStashedPrompt(settledTurn)).toBe(true);
  });

  it("stays parked while the setting is off", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, enabled: false })).toBe(false);
  });

  it("does nothing with an empty stash", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, hasStashedPrompt: false })).toBe(false);
  });

  it("ignores a thread that was already idle", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, wasWorking: false })).toBe(false);
  });

  it("waits until the thread stops working", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, isWorking: true, phase: "running" })).toBe(
      false,
    );
  });

  it("holds the stash when the turn was interrupted or failed", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, phase: "disconnected" })).toBe(false);
  });

  it("yields to a prompt the user is writing", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, hasComposerContent: true })).toBe(false);
  });

  it("holds while something else owns the composer", () => {
    expect(shouldAutoSendStashedPrompt({ ...settledTurn, sendBlocked: true })).toBe(false);
  });
});
