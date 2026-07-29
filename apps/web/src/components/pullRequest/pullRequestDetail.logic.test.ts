import type { PullRequestCheck, PullRequestComment, PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFixFindingsPrompt,
  buildPullRequestTimeline,
  describePullRequestState,
} from "./pullRequestDetail.logic";

const TIMELINE_SOURCE: Pick<
  PullRequestDetail,
  "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
> = {
  createdAt: "2026-07-01T00:00:00Z",
  author: { login: "octocat", name: null },
  commits: [
    { oid: "1baf7bdcafe", messageHeadline: "add the page", committedDate: "2026-07-02T00:00:00Z" },
  ],
  comments: [
    {
      id: "c1",
      kind: "issue-comment",
      author: { login: "bilal", name: null },
      body: "looks good",
      createdAt: "2026-07-03T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  mergedAt: null,
  closedAt: null,
};

describe("pull request state description", () => {
  it("keeps draft and conflicts orthogonal to the terminal states", () => {
    expect(describePullRequestState("open", true)).toBe("Draft");
    expect(describePullRequestState("open", false)).toBe("Ready for review");
    expect(describePullRequestState("merged", true)).toBe("Merged");
    expect(describePullRequestState("closed", false)).toBe("Closed");
  });
});

describe("pull request timeline", () => {
  it("orders creation, commits and comments chronologically", () => {
    expect(buildPullRequestTimeline(TIMELINE_SOURCE).map((event) => event.id)).toEqual([
      "created",
      "1baf7bdcafe",
      "c1",
    ]);
  });

  it("reports a merge rather than the close GitHub records alongside it", () => {
    const events = buildPullRequestTimeline({
      ...TIMELINE_SOURCE,
      mergedAt: "2026-07-04T00:00:00Z",
      closedAt: "2026-07-04T00:00:00Z",
    });
    expect(events.at(-1)?.id).toBe("merged");
    expect(events.some((event) => event.id === "closed")).toBe(false);
  });
});

describe("fix findings prompt", () => {
  const base = {
    number: 42,
    title: "Add the pull requests page",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    headBranch: "feat/page",
    baseBranch: "main",
    commentsTruncated: false,
  };

  function review(body: string): PullRequestComment {
    return {
      id: "r1",
      kind: "review",
      author: { login: "reviewer", name: null },
      body,
      createdAt: "2026-07-03T00:00:00Z",
      url: null,
      path: null,
      reviewState: "CHANGES_REQUESTED",
    };
  }

  const failingCheck: PullRequestCheck = {
    name: "typecheck",
    status: "failure",
    description: "2 errors",
    url: null,
  };

  it("quotes review findings and failing checks as untrusted data", () => {
    const prompt = buildFixFindingsPrompt({
      ...base,
      comments: [review("rename the helper")],
      checks: [failingCheck],
    });
    expect(prompt).toContain("> rename the helper");
    expect(prompt).toContain("> typecheck — 2 errors");
    expect(prompt).toContain("untrusted data");
  });

  it("says so plainly when there is nothing actionable to quote", () => {
    const prompt = buildFixFindingsPrompt({ ...base, comments: [], checks: [] });
    expect(prompt).toContain("No explicit review findings were returned");
  });

  it("bounds a hostile review body instead of pasting it whole", () => {
    const prompt = buildFixFindingsPrompt({
      ...base,
      comments: [review("x".repeat(5_000))],
      checks: [],
    });
    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(2_000);
  });

  it("keeps the newest findings and the failing checks when it has to cut", () => {
    const prompt = buildFixFindingsPrompt({
      ...base,
      comments: Array.from({ length: 25 }, (_, index) => ({
        ...review(`finding ${index}`),
        id: `r${index}`,
      })),
      checks: [failingCheck],
    });
    // Oldest reviews are dropped rather than the current failure and the recent feedback.
    expect(prompt).toContain("finding 24");
    expect(prompt).toContain("typecheck");
    expect(prompt).not.toContain("finding 0:");
  });

  it("reports how many findings the bound left out", () => {
    const prompt = buildFixFindingsPrompt({
      ...base,
      comments: Array.from({ length: 25 }, () => review("finding")),
      checks: [],
    });
    expect(prompt).toContain("5 further findings were omitted");
  });
});
