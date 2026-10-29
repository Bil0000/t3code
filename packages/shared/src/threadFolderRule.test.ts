import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pickThreadFolderForRule,
  threadFolderRuleHasConditions,
  threadMatchesFolderRule,
} from "./threadFolderRule.ts";

const thread = {
  projectId: ProjectId.make("project:web"),
  title: "Review PR 12165: status dropdown",
  branch: "t3code/fix-status-dropdown",
  worktreePath: "/root/.t3/worktrees/t3code/fix-status-dropdown",
  providerInstanceId: ProviderInstanceId.make("codex"),
  hasPullRequest: true,
};

describe("threadMatchesFolderRule", () => {
  it("counts only enabled smart rules as conditions", () => {
    expect(threadFolderRuleHasConditions({ smart: true })).toBe(true);
    expect(threadFolderRuleHasConditions({ smart: false })).toBe(false);
  });
  it.each([
    [{}, false],
    [{ smart: true }, false],
    [{ smart: true, branches: ["t3code/fix-*"] }, true],
    [{ branches: ["t3code/fix-*"] }, true],
    [{ branches: ["T3CODE/FIX-STATUS-DROPDOWN"] }, true],
    [{ branches: ["main"] }, false],
    [{ worktrees: ["fix-status-*"] }, true],
    [{ worktrees: ["/root/.t3/worktrees/*"] }, true],
    [{ titleKeywords: ["review", "audit"] }, true],
    [{ titleKeywords: ["audit"] }, false],
    [{ titleKeywords: ["view"] }, false],
    [{ titleKeywords: ["revie"] }, true],
    [{ titleKeywords: ["pr 12165"] }, true],
    [{ titleKeywords: ["status dropdown"] }, true],
    [{ pullRequest: true }, true],
    [{ pullRequest: false }, false],
    [{ projectIds: [ProjectId.make("project:web")], titleKeywords: ["review"] }, true],
    [{ projectIds: [ProjectId.make("project:mobile")], titleKeywords: ["review"] }, false],
    [{ providerInstanceIds: [ProviderInstanceId.make("claudeAgent")] }, false],
    [{ branches: ["a.b"] }, false],
  ])("%j matches: %s", (rule, expected) => {
    expect(threadMatchesFolderRule(rule, thread)).toBe(expected);
  });

  it("matches hostile globs without backtracking", () => {
    const branch = "a".repeat(5_000);
    expect(
      threadMatchesFolderRule({ branches: ["*a".repeat(40) + "b"] }, { ...thread, branch }),
    ).toBe(false);
    expect(threadMatchesFolderRule({ branches: ["*a*a*"] }, { ...thread, branch })).toBe(true);
  });

  it("never matches a missing branch or worktree", () => {
    const bare = { ...thread, branch: null, worktreePath: null };
    expect(threadMatchesFolderRule({ branches: ["*"] }, bare)).toBe(false);
    expect(threadMatchesFolderRule({ worktrees: ["*"] }, bare)).toBe(false);
  });
});

describe("pickThreadFolderForRule", () => {
  it("takes the first enabled match in folder order", () => {
    const folders = [
      { id: "smart", rule: { smart: true, pullRequest: true }, autoFile: true },
      { id: "off", rule: { pullRequest: true }, autoFile: false },
      { id: "none", rule: null, autoFile: true },
      { id: "reviews", rule: { titleKeywords: ["review"] }, autoFile: true },
      { id: "prs", rule: { pullRequest: true }, autoFile: true },
    ];
    expect(pickThreadFolderForRule(folders, thread)?.id).toBe("reviews");
    expect(pickThreadFolderForRule(folders, { ...thread, title: "x", hasPullRequest: false })).toBe(
      null,
    );
  });
});
