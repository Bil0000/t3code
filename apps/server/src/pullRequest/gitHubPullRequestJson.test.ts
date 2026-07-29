import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePullRequestDetailJson,
  decodePullRequestListJson,
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
    );
    expect(entry?.state).toBe("merged");
  });

  it("normalizes mergeability and defaults unknown values", () => {
    const entries = expectSuccess(
      decodePullRequestListJson(
        listJson([{ mergeable: "CONFLICTING" }, { mergeable: "SOMETHING_NEW" }, {}]),
      ),
    );
    expect(entries.map((entry) => entry.mergeability)).toEqual([
      "conflicting",
      "unknown",
      "unknown",
    ]);
  });

  it("reads review requests from user logins and team slugs alike", () => {
    const [entry] = expectSuccess(
      decodePullRequestListJson(
        listJson([{ reviewRequests: [{ login: "octocat" }, { slug: "web-platform" }] }]),
      ),
    );
    expect(entry?.reviewRequestLogins).toEqual(["octocat", "web-platform"]);
  });

  it("skips malformed entries instead of failing the batch", () => {
    const raw = `[${listJson([{}]).slice(1, -1)},{"number":"not-a-number"}]`;
    expect(expectSuccess(decodePullRequestListJson(raw))).toHaveLength(1);
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

  it("merges reviews with comments in time order and drops bodyless reviews", () => {
    const detail = expectSuccess(decodePullRequestDetailJson(detailJson));
    expect(detail.comments.map((comment) => comment.id)).toEqual(["r1", "c1"]);
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
