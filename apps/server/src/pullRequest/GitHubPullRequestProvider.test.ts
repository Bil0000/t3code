import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import { gitHubViewerPermissions, loginAvatarUrl, make } from "./GitHubPullRequestProvider.ts";
import type { GitHubReviewThreadComments } from "./gitHubPullRequestJson.ts";

describe("gitHubViewerPermissions", () => {
  it("offers everything to a viewer who can write to the repository", () => {
    expect(gitHubViewerPermissions({ canWrite: true, canUpdate: true, didAuthor: false })).toEqual({
      actions: ["merge", "ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });

  it("leaves a passer-by on a repository they can only read nothing but the review", () => {
    // Every open-source pull request somebody else opened: GitHub says no to all five actions
    // and to resolving, and yes to commenting and to every verdict.
    expect(
      gitHubViewerPermissions({ canWrite: false, canUpdate: false, didAuthor: false }),
    ).toEqual({
      actions: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      // Asking somebody else to review is the one thing read access never stretches to.
      requestReviewers: false,
    });
  });

  it("keeps an author's own pull request theirs to close, with read access and no more", () => {
    expect(gitHubViewerPermissions({ canWrite: false, canUpdate: true, didAuthor: true })).toEqual({
      // Merging is the one thing writing is needed for; the rest an author may do.
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      // GitHub refuses an author's approval of their own change, so the page does not offer one.
      verdicts: ["comment"],
      requestReviewers: false,
    });
  });

  it.effect("uses the small viewer-access read for core permissions", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.viewerPermissions).toEqual({
        actions: ["ready", "draft", "close", "reopen"],
        comment: true,
        resolve: false,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: false,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () =>
            Effect.succeed({
              authorId: null,
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              author: null,
              headBranch: "feat/page",
              baseBranch: "main",
              state: "open",
              isDraft: false,
              mergeability: "mergeable",
              additions: 1,
              deletions: 1,
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
              reviewRequestLogins: [],
              hasTeamReviewRequest: false,
              labels: [],
              body: "",
              changedFiles: 1,
              mergedAt: null,
              closedAt: null,
              checks: [],
              comments: [],
              commits: [],
            }),
          getRepositoryAccess: () =>
            Effect.succeed({
              canWrite: false,
              mergeCapabilities: { merge: true, squash: true, rebase: true },
            }),
          getViewerAccess: () =>
            Effect.succeed({ canWrite: false, canUpdate: true, didAuthor: false }),
        }),
      ),
    ),
  );
});

describe("getChangeRequest commits", () => {
  const baseDetail = {
    authorId: null,
    number: 7,
    title: "Pull request 7",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 1,
    deletions: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    checks: [],
    comments: [],
  };

  const baseThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map<string, string>(),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewers: [],
    avatarsByLogin: new Map<string, string>(),
    commitStats: new Map<string, { readonly additions: number; readonly deletions: number }>(),
    viewer: { canUpdate: true, didAuthor: false },
  };

  const layerWith = (commits: GitHubReviewThreadComments["commits"]) =>
    Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
      getPullRequestActivity: () =>
        Effect.succeed({
          author: baseDetail.author,
          comments: baseDetail.comments,
          commits: [
            {
              oid: "view-oldest",
              messageHeadline: "gh pr view's oldest commit",
              committedDate: "2026-01-01T00:00:00Z",
              authors: [],
            },
          ],
        }),
      listReviewThreadComments: () => Effect.succeed({ ...baseThreadComments, commits }),
    });

  it.effect("prefers the GraphQL commits, which are the newest, over the gh view list", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest"]);
    }).pipe(
      Effect.provide(
        layerWith([
          {
            oid: "graphql-newest",
            messageHeadline: "the newest commit gh pr view drops",
            committedDate: "2026-07-06T00:00:00Z",
            authors: [],
          },
        ]),
      ),
    ),
  );

  it.effect("falls back to the gh view list when the GraphQL read has no commits", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["view-oldest"]);
    }).pipe(Effect.provide(layerWith([]))),
  );
});

describe("getChangeRequestActivity dismissed reviews", () => {
  const dismissedReview = (body: string) => ({
    id: "PRR_1",
    kind: "review" as const,
    author: null,
    body,
    createdAt: "2026-07-03T00:00:00Z",
    url: null,
    path: null,
    reviewState: "DISMISSED",
  });
  const threadComments: GitHubReviewThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map([["PRR_1", "Dismissing prior approval to re-evaluate 9b66581"]]),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewers: [],
    avatarsByLogin: new Map(),
    commitStats: new Map(),
    commits: [],
    viewer: { canUpdate: true, didAuthor: false },
  };
  const layerFor = (body: string) =>
    Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
      getPullRequestActivity: () =>
        Effect.succeed({ author: null, comments: [dismissedReview(body)], commits: [] }),
      listReviewThreadComments: () => Effect.succeed(threadComments),
    });
  const readActivity = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      number: 7,
    });
  });

  it.effect("fills a marker-only dismissed review with the timeline's reason", () =>
    // Macroscope's approvals carry only an HTML comment, which markdown renders as nothing —
    // an empty-string check misses them and the card opens onto nothing.
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("Dismissing prior approval to re-evaluate 9b66581");
      }),
      Effect.provide(layerFor("<!-- Macroscope (Approvability) review body marker -->")),
    ),
  );

  it.effect("keeps the words of a dismissed review that has its own", () =>
    readActivity.pipe(
      Effect.map((activity) => {
        expect(activity.comments[0]?.body).toBe("These findings still stand.");
      }),
      Effect.provide(layerFor("These findings still stand.")),
    ),
  );
});

describe("loginAvatarUrl", () => {
  it("serves a user's picture from the host they belong to", () => {
    expect(loginAvatarUrl("octocat", "github.com")).toBe("https://github.com/octocat.png?size=80");
    expect(loginAvatarUrl("octocat", "ghe.example.com")).toBe(
      "https://ghe.example.com/octocat.png?size=80",
    );
  });

  it("has nothing for an app, which names no page", () => {
    // `dependabot[bot]` has a picture, but not at `/dependabot[bot].png` — a guess that 404s is
    // worse than the initials it would replace.
    expect(loginAvatarUrl("dependabot[bot]", "github.com")).toBeNull();
  });

  it("refuses anything that is not a login, rather than building a URL out of it", () => {
    for (const login of ["../../etc", "a b", "-leading", "x".repeat(40), ""]) {
      expect(loginAvatarUrl(login, "github.com")).toBeNull();
    }
  });
});
