import { assert, describe, it } from "@effect/vitest";

import {
  classifyIncomingTip,
  handoffPreTagName,
  handoffRefName,
  handoffStashLabel,
  type ClassifyIncomingTipInput,
} from "./ThreadHandoffGit.ts";

const input = (overrides: Partial<ClassifyIncomingTipInput>): ClassifyIncomingTipInput => ({
  localTip: "local",
  incomingTip: "incoming",
  incomingContainsLocal: false,
  localContainsIncoming: false,
  hasCommonAncestor: true,
  ...overrides,
});

describe("classifyIncomingTip", () => {
  it("advances a branch the receiving repository does not have yet", () => {
    assert.strictEqual(classifyIncomingTip(input({ localTip: null })), "advance");
  });

  it("absorbs an identical tip instead of moving anything", () => {
    assert.strictEqual(
      classifyIncomingTip(input({ localTip: "same", incomingTip: "same" })),
      "absorb",
    );
  });

  it("advances when the incoming commit descends from the local tip", () => {
    assert.strictEqual(classifyIncomingTip(input({ incomingContainsLocal: true })), "advance");
  });

  it("absorbs when the receiving side is already ahead", () => {
    assert.strictEqual(classifyIncomingTip(input({ localContainsIncoming: true })), "absorb");
  });

  it("refuses when both sides moved, so neither tip is a descendant of the other", () => {
    assert.strictEqual(classifyIncomingTip(input({})), "diverged");
  });

  it("refuses unrelated histories rather than treating them as a divergence to rebase", () => {
    assert.strictEqual(classifyIncomingTip(input({ hasCommonAncestor: false })), "unrelated");
  });

  it("treats a fast-forward as advance even when common ancestry was not computed", () => {
    assert.strictEqual(
      classifyIncomingTip(input({ incomingContainsLocal: true, hasCommonAncestor: false })),
      "advance",
    );
  });

  it("never advances on a tip that only the local side contains", () => {
    const classification = classifyIncomingTip(
      input({ localContainsIncoming: true, hasCommonAncestor: true }),
    );

    assert.notStrictEqual(classification, "advance");
  });
});

describe("handoff ref names", () => {
  it("parks refused commits under an environment-scoped namespace", () => {
    assert.strictEqual(
      handoffRefName("environment-mac", "feat/thread-handoff"),
      "refs/handoff/environment-mac/feat/thread-handoff",
    );
  });

  it("keeps each refused handoff's parked commit under its own ref", () => {
    assert.strictEqual(
      handoffRefName("environment-mac", "feat/thread-handoff", "handoff-1"),
      "refs/handoff/environment-mac/handoff-1/feat/thread-handoff",
    );
  });

  it("rewrites characters git refuses inside a ref name", () => {
    assert.strictEqual(handoffRefName("env one", "feat/a..b~c"), "refs/handoff/env-one/feat/a-b-c");
  });

  it("names the pre-move tag after the hop that moved the pointer", () => {
    assert.strictEqual(handoffPreTagName("handoff-1"), "handoff-pre-handoff-1");
  });

  it("puts the base sha in the stash label so a later pop is legible", () => {
    assert.strictEqual(
      handoffStashLabel("handoff-1", "a91f2c4"),
      "handoff-overwritten-handoff-1-base-a91f2c4",
    );
  });
});
