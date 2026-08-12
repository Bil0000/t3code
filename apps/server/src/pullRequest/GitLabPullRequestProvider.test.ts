import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueLink } from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      actions: ["merge", "ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      // GitLab says nothing about who may set a reviewer, and an unreported permission is granted.
      requestReviewers: true,
    });
  });

  it("keeps merge from a viewer GitLab says cannot", () => {
    // `user.can_merge` already accounts for the role, the approval rules and a protected target
    // branch, so it is the one answer here that does not have to be inferred.
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
    });
  });

  it("treats an author with read access as any other reader, which is all GitLab says", () => {
    // Its REST API names no relationship between the viewer and the merge request beyond
    // `can_merge`, so the four an author keeps stay offered to everyone rather than being taken
    // from the one person entitled to them.
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).actions).toEqual([
      "ready",
      "draft",
      "close",
      "reopen",
    ]);
  });
});

describe("getChangeRequest linked issues", () => {
  const issue = (number: number, closesIssue: boolean): IssueLink => ({
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://gitlab.com/acme/web/-/issues/${number}`,
    state: "open",
    closesIssue,
  });

  const detailWith = (body: string) => ({
    number: 7,
    title: "Open an issue beside a thread",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body,
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  });

  const layerWith = (input: {
    readonly body: string;
    readonly linked: ReadonlyArray<IssueLink>;
    readonly listCitedIssues: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"];
  }) =>
    Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
      getMergeRequestDetail: () => Effect.succeed(detailWith(input.body)),
      getProjectMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: false }),
      listLinkedIssues: () => Effect.succeed(input.linked),
      listCitedIssues: input.listCitedIssues,
    });

  const read = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "gitlab.com",
      number: 7,
    });
  });

  it.effect("adds an issue the description only cites, from this project alone", () => {
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    return read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues.map((link) => [link.number, link.closesIssue])).toEqual([
          [12, true],
          [34, false],
        ]);
        // GitLab's issues endpoint is per project, and one read is the whole budget here.
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual([34]);
      }),
      Effect.provide(
        layerWith({
          body: "Closes #12. Part of #34 and of acme/tools#9.",
          linked: [issue(12, true)],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("drops a reference GitLab answered nothing for", () =>
    read.pipe(
      Effect.map((detail) => expect(detail.linkedIssues).toEqual([])),
      Effect.provide(
        layerWith({
          body: "Part of #404.",
          linked: [],
          listCitedIssues: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("keeps the host's own links when the lookup fails", () =>
    read.pipe(
      Effect.map((detail) => expect(detail.linkedIssues).toEqual([issue(12, true)])),
      Effect.provide(
        layerWith({
          body: "Part of #34.",
          linked: [issue(12, true)],
          listCitedIssues: () =>
            Effect.fail(
              new GitLabPullRequestCli.GitLabMergeRequestReadError({
                command: "glab",
                cwd: "/w",
                operation: "listCitedIssues",
                cause: new Error("404 Project Not Found"),
              }),
            ),
        }),
      ),
    ),
  );
});
