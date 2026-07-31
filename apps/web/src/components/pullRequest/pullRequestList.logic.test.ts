import type { PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
} from "./pullRequestList.logic";

const VIEWERS = { "github.com": "Bilal" } as const;
const NO_VIEWERS = {} as const;

function entry(overrides: Partial<PullRequestListEntry> & Pick<PullRequestListEntry, "number">) {
  return {
    provider: "github",
    host: "github.com",
    projectId: "project-1",
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    title: "Add the pull requests page",
    url: `https://github.com/pingdotgg/t3code/pull/${overrides.number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/branch-${overrides.number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  } as PullRequestListEntry;
}

describe("pull request involvement filtering", () => {
  const entries = [
    entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
    entry({ number: 2, viewerReviewRequested: true }),
    entry({ number: 3 }),
  ];

  it("matches the viewer's own pull requests case-insensitively", () => {
    expect(
      filterPullRequestsByInvolvement(entries, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("returns nothing for Authored when the viewer is unknown", () => {
    expect(filterPullRequestsByInvolvement(entries, NO_VIEWERS, "authored")).toEqual([]);
  });

  it("uses the server-computed review-request flag for Reviewing", () => {
    expect(
      filterPullRequestsByInvolvement(entries, VIEWERS, "reviewing").map((item) => item.number),
    ).toEqual([2]);
  });

  it("does not treat a matching login on another host as the viewer", () => {
    // The same name on GitLab is a different account, and its viewer is unknown here.
    const mixed = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({
        number: 2,
        provider: "gitlab",
        host: "gitlab.com",
        author: { login: "Bilal", name: null, avatarUrl: null },
      }),
    ];
    expect(
      filterPullRequestsByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("leaves the superset untouched for All", () => {
    expect(filterPullRequestsByInvolvement(entries, VIEWERS, "all")).toHaveLength(3);
  });

  it("keeps two hosts of one provider kind as two accounts", () => {
    // A GitHub Enterprise install is a different account from github.com, so the viewer for
    // one must not claim authorship of the other's change requests.
    const mixed = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({
        number: 2,
        host: "github.acme.dev",
        author: { login: "Bilal", name: null, avatarUrl: null },
      }),
    ];
    expect(
      filterPullRequestsByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });
});

describe("pull request grouping", () => {
  it("buckets authored above review-requested and drops empty groups", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry({ number: 1, author: { login: "bilal", name: null, avatarUrl: null } }),
        entry({ number: 2, viewerReviewRequested: true }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => [group.key, group.entries.length])).toEqual([
      ["reviewRequested", 1],
      ["authored", 1],
    ]);
  });

  it("puts everything in Others when the viewer is unknown", () => {
    const groups = groupPullRequestsByInvolvement([entry({ number: 1 })], NO_VIEWERS);
    expect(groups.map((group) => group.key)).toEqual(["others"]);
  });

  it("counts an authored pull request once, even with a review request on it", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry({
          number: 1,
          author: { login: "bilal", name: null, avatarUrl: null },
          viewerReviewRequested: true,
        }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => group.key)).toEqual(["authored"]);
  });
});

describe("pull request search", () => {
  const target = entry({
    number: 4711,
    title: "Restore sidebar actions",
    headBranch: "fix/sidebar",
  });

  it("matches the number with or without the leading hash", () => {
    expect(matchesPullRequestQuery(target, "#4711")).toBe(true);
    expect(matchesPullRequestQuery(target, "4711")).toBe(true);
  });

  it("matches title, branch and author case-insensitively", () => {
    expect(matchesPullRequestQuery(target, "SIDEBAR")).toBe(true);
    expect(matchesPullRequestQuery(target, "fix/side")).toBe(true);
    expect(matchesPullRequestQuery(target, "octocat")).toBe(true);
  });

  it("ignores surrounding whitespace and rejects non-matches", () => {
    expect(matchesPullRequestQuery(target, "   ")).toBe(true);
    expect(matchesPullRequestQuery(target, "kanban")).toBe(false);
  });
});
