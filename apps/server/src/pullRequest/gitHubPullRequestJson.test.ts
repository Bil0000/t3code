import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePullRequestDetailJson,
  decodePullRequestListJson,
  decodeRepositoryMergeCapabilitiesJson,
  decodeReviewThreadsJson,
} from "./gitHubPullRequestJson.ts";

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify(
    entries.map((entry) => ({
      number: 1,
      title: "Add the pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      ...entry,
    })),
  );
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("pull request list decoding", () => {
  it("treats a merge timestamp as merged even when the state still says closed", () => {
    const [entry] = expectSuccess(
      decodePullRequestListJson(listJson([{ state: "CLOSED", mergedAt: "2026-07-03T00:00:00Z" }])),
    ).items;
    expect(entry?.state).toBe("merged");
  });

  it("normalizes mergeability and defaults unknown values", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        listJson([{ mergeable: "CONFLICTING" }, { mergeable: "SOMETHING_NEW" }, {}]),
      ),
    );
    expect(batch.items.map((entry) => entry.mergeability)).toEqual([
      "conflicting",
      "unknown",
      "unknown",
    ]);
  });

  it("keeps user review requests and drops team ones, which are not logins", () => {
    const [entry] = expectSuccess(
      decodePullRequestListJson(
        listJson([{ reviewRequests: [{ login: "octocat" }, { slug: "web-platform" }] }]),
      ),
    ).items;
    expect(entry?.reviewRequestLogins).toEqual(["octocat"]);
  });

  it("skips malformed entries but still counts them, so paging does not stop early", () => {
    const raw = `[${listJson([{}]).slice(1, -1)},{"number":"not-a-number"}]`;
    const batch = expectSuccess(decodePullRequestListJson(raw));
    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
  });
});

describe("pull request detail decoding", () => {
  const detailJson = JSON.stringify({
    number: 7,
    title: "Detail",
    url: "https://github.com/pingdotgg/t3code/pull/7",
    headRefName: "feat/detail",
    baseRefName: "main",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    body: "Body",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
    ],
    comments: [{ id: "c1", body: "second", createdAt: "2026-07-04T00:00:00Z" }],
    reviews: [
      { id: "r1", body: "first", state: "CHANGES_REQUESTED", submittedAt: "2026-07-03T00:00:00Z" },
      { id: "r2", body: "   ", state: "APPROVED", submittedAt: "2026-07-06T00:00:00Z" },
    ],
  });

  it("maps check-run status and commit-status state onto one vocabulary", () => {
    const detail = expectSuccess(decodePullRequestDetailJson(detailJson));
    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
      ["build", "pending"],
      ["test", "failure"],
      ["ci/legacy", "success"],
    ]);
  });

  it("merges reviews with comments in time order and keeps a bodyless approval", () => {
    const detail = expectSuccess(decodePullRequestDetailJson(detailJson));
    // r2 approved without writing anything, which is still the event worth seeing.
    expect(detail.comments.map((comment) => comment.id)).toEqual(["r1", "c1", "r2"]);
    expect(detail.comments.at(-1)?.reviewState).toBe("APPROVED");
  });

  it("drops a review that carries neither a body nor a state", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      decodePullRequestDetailJson(
        JSON.stringify({
          ...raw,
          reviews: [{ id: "r3", body: "  ", submittedAt: "2026-07-07T00:00:00Z" }],
        }),
      ),
    );
    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1"]);
  });
});

describe("review thread decoding", () => {
  const threadsJson = (
    nodes: ReadonlyArray<Record<string, unknown>>,
    totalCount = nodes.length,
  ): string =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } },
    });

  /** The same query carries the review roster, so it is built alongside the threads. */
  const reviewJson = (input: {
    readonly requested?: ReadonlyArray<unknown>;
    readonly reviewed?: ReadonlyArray<unknown>;
  }): string =>
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: 0, nodes: [] },
            reviewRequests: {
              nodes: (input.requested ?? []).map((r) => ({ requestedReviewer: r })),
            },
            latestReviews: { nodes: (input.reviewed ?? []).map((a) => ({ author: a })) },
          },
        },
      },
    });

  it("keeps a reviewer who has already reviewed, app or person, with their avatar", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/j.png" }],
          // An app that has reviewed is no longer an outstanding request, which is why asking
          // only for requests reported nobody on a pull request a bot had reviewed.
          reviewed: [{ login: "macroscopeapp", avatarUrl: "https://avatars/in/900172.png" }],
        }),
      ),
    );

    expect(result.reviewers).toEqual([
      { login: "julius", name: "Julius", avatarUrl: "https://avatars/j.png" },
      { login: "macroscopeapp", name: null, avatarUrl: "https://avatars/in/900172.png" },
    ]);
  });

  it("lists someone who was asked and then answered only once", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [{ login: "julius", avatarUrl: "https://avatars/j.png" }],
          reviewed: [{ login: "julius", avatarUrl: "https://avatars/j.png" }],
        }),
      ),
    );

    expect(result.reviewers).toHaveLength(1);
  });

  it("skips a team request, which names nobody to show", () => {
    const result = expectSuccess(decodeReviewThreadsJson(reviewJson({ requested: [null] })));

    expect(result.reviewers).toEqual([]);
  });

  it("keeps the conversation when a request is from a team, which has no login", () => {
    // GraphQL answers with an empty object for a union member the query has no fragment for.
    // Failing on it would take the whole response down, comments included.
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({ requested: [{}, { login: "julius", avatarUrl: "https://avatars/j.png" }] }),
      ),
    );

    expect(result.reviewers).toEqual([
      { login: "julius", name: null, avatarUrl: "https://avatars/j.png" },
    ]);
  });

  it("keeps unresolved threads and carries their file path", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            isResolved: false,
            path: "apps/server/src/ws.ts",
            comments: {
              nodes: [{ id: "t1", body: "fix this", createdAt: "2026-07-01T00:00:00Z" }],
            },
          },
          {
            isResolved: true,
            path: "apps/web/src/main.tsx",
            comments: { nodes: [{ id: "t2", body: "done", createdAt: "2026-07-01T00:00:00Z" }] },
          },
        ]),
      ),
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      id: "t1",
      kind: "review-comment",
      path: "apps/server/src/ws.ts",
    });
  });

  it("reports truncation when GitHub has more threads than the page returned", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson(
          [
            {
              isResolved: false,
              comments: { nodes: [{ id: "t1", createdAt: "2026-07-01T00:00:00Z" }] },
            },
          ],
          80,
        ),
      ),
    );
    expect(result.truncated).toBe(true);
  });
});

describe("repository merge capability decoding", () => {
  it("reads the three settings gh reports", () => {
    expect(
      expectSuccess(
        decodeRepositoryMergeCapabilitiesJson(
          JSON.stringify({
            mergeCommitAllowed: true,
            squashMergeAllowed: false,
            rebaseMergeAllowed: true,
          }),
        ),
      ),
    ).toEqual({ merge: true, squash: false, rebase: true });
  });

  it("fails rather than defaulting open when a setting is missing", () => {
    const decoded = decodeRepositoryMergeCapabilitiesJson(
      JSON.stringify({ mergeCommitAllowed: true }),
    );
    expect(Result.isSuccess(decoded)).toBe(false);
  });
});
