import type { PullRequestAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  beginPullRequestAction,
  completePullRequestAction,
  EMPTY_PULL_REQUEST_ACTION_STATE,
  failPullRequestAction,
  observePullRequestDetail,
  pullRequestActionStateAtom,
} from "./pullRequestActionState.ts";

function completedMerge() {
  return completePullRequestAction(
    beginPullRequestAction(EMPTY_PULL_REQUEST_ACTION_STATE, "merge"),
    "merge",
  );
}

describe("pullRequestActionState", () => {
  it("isolates action lifecycles by pull request key", () => {
    const registry = AtomRegistry.make();
    const pullRequestA = pullRequestActionStateAtom("project:repo#1");
    const pullRequestB = pullRequestActionStateAtom("project:repo#2");

    registry.set(pullRequestA, beginPullRequestAction(registry.get(pullRequestA), "merge"));
    registry.set(pullRequestB, beginPullRequestAction(registry.get(pullRequestB), "merge"));

    expect(registry.get(pullRequestA)).toMatchObject({
      pendingAction: "merge",
      mergeHold: false,
    });
    expect(registry.get(pullRequestB)).toMatchObject({
      pendingAction: "merge",
      mergeHold: false,
    });

    registry.set(pullRequestA, completePullRequestAction(registry.get(pullRequestA), "merge"));
    registry.set(pullRequestB, completePullRequestAction(registry.get(pullRequestB), "merge"));

    expect(registry.get(pullRequestA).mergeHold).toBe(true);
    expect(registry.get(pullRequestB).mergeHold).toBe(true);

    registry.dispose();
  });

  it("clears a merge hold when detail leaves open", () => {
    const state = observePullRequestDetail(completedMerge(), {
      state: "merged",
      isPending: false,
    });

    expect(state).toEqual(EMPTY_PULL_REQUEST_ACTION_STATE);
  });

  it("clears a merge hold when a post-hold read settles still open", () => {
    const pending = observePullRequestDetail(completedMerge(), {
      state: "open",
      isPending: true,
    });
    const settled = observePullRequestDetail(pending, {
      state: "open",
      isPending: false,
    });

    expect(pending.mergeHold).toBe(true);
    expect(settled).toEqual(EMPTY_PULL_REQUEST_ACTION_STATE);
  });

  it("does not clear a merge hold from the stale settled detail at hold-set time", () => {
    const state = observePullRequestDetail(completedMerge(), {
      state: "open",
      isPending: false,
    });

    expect(state).toMatchObject({ mergeHold: true, observedPostMergeRead: false });
  });

  it("clears the pending action on failure", () => {
    const actions: ReadonlyArray<PullRequestAction> = ["merge", "close"];

    for (const action of actions) {
      expect(
        failPullRequestAction(beginPullRequestAction(EMPTY_PULL_REQUEST_ACTION_STATE, action)),
      ).toEqual(EMPTY_PULL_REQUEST_ACTION_STATE);
    }
  });
});
