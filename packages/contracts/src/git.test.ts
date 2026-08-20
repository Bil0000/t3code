import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsGetHistoryResult,
  VcsGetCommitDiffInput,
  VcsGetCommitDetailsInput,
  VcsListCommitFilesResult,
  VcsStatusResult,
  VcsListHistoryRefsInput,
  VcsListRefsInput,
  VcsListRefsResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeListRefsInput = Schema.decodeUnknownSync(VcsListRefsInput);
const decodeListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);
const decodeListHistoryRefsInput = Schema.decodeUnknownSync(VcsListHistoryRefsInput);
const decodeCommitDetailsInput = Schema.decodeUnknownSync(VcsGetCommitDetailsInput);
const decodeCommitDiffInput = Schema.decodeUnknownSync(VcsGetCommitDiffInput);
const decodeListCommitFilesResult = Schema.decodeUnknownSync(VcsListCommitFilesResult);
const decodeStatusResult = Schema.decodeUnknownSync(VcsStatusResult);
const decodeGetHistoryResult = Schema.decodeUnknownSync(VcsGetHistoryResult);

describe("VCS ref contracts", () => {
  it("preserves the numeric cursor and result shape of vcs.listRefs", () => {
    expect(decodeListRefsInput({ cwd: "/repo", cursor: 20, query: "release" })).toEqual({
      cwd: "/repo",
      cursor: 20,
      query: "release",
    });
    expect(
      decodeListRefsResult({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: 20,
        totalCount: 25,
      }).totalCount,
    ).toBe(25);
  });

  it("uses an opaque cursor only for vcs.listHistoryRefs", () => {
    expect(
      decodeListHistoryRefsInput({
        cwd: "/repo",
        cursor: "opaque-cursor",
        query: "Release",
        namespace: "tag",
      }),
    ).toEqual({
      cwd: "/repo",
      cursor: "opaque-cursor",
      query: "Release",
      namespace: "tag",
    });
    expect(() => decodeListRefsInput({ cwd: "/repo", cursor: "opaque-cursor" })).toThrow();
  });
});

describe("Git commit hashes", () => {
  it("accepts SHA-1 and SHA-256 object hashes", () => {
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "a".repeat(40) }).hash).toHaveLength(40);
    expect(decodeCommitDetailsInput({ cwd: "/repo", hash: "b".repeat(64) }).hash).toHaveLength(64);
  });
});

describe("Git file path contracts", () => {
  it("preserves leading and trailing whitespace in file-path requests and results", () => {
    const filePath = " leading-and-trailing.txt ";

    expect(
      decodeRunStackedActionInput({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [filePath],
      }).filePaths,
    ).toEqual([filePath]);
    expect(
      decodeCommitDiffInput({
        cwd: "/repo",
        hash: "a".repeat(40),
        filePath,
      }).filePath,
    ).toBe(filePath);
    expect(
      decodeListCommitFilesResult({
        files: [{ status: "M", path: filePath }],
        isRepo: true,
        nextCursor: null,
        hasMore: false,
        capped: false,
      }).files[0]?.path,
    ).toBe(filePath);
    expect(
      decodeStatusResult({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: filePath, insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }).workingTree.files[0]?.path,
    ).toBe(filePath);
  });
});

describe("Git history results", () => {
  it("preserves an explicit capped signal for incomplete history snapshots", () => {
    expect(
      decodeGetHistoryResult({
        commits: [],
        isRepo: true,
        nextCursor: null,
        hasMore: false,
        capped: true,
      }).capped,
    ).toBe(true);
  });

  it("preserves commits whose Git identity fields are empty", () => {
    const result = decodeGetHistoryResult({
      commits: [
        {
          hash: "a".repeat(40),
          parentHashes: [],
          subject: "identity-less commit",
          authorName: "",
          authorEmail: "",
          authoredAt: "2026-08-19T00:00:00Z",
          refs: [],
        },
      ],
      isRepo: true,
      nextCursor: null,
      hasMore: false,
    });

    expect(result.commits[0]?.authorName).toBe("");
    expect(result.commits[0]?.authorEmail).toBe("");
  });
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
