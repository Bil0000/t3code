import * as Effect from "effect/Effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { BitbucketPullRequest } from "./bitbucketPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // Bitbucket has no endpoint that reopens a declined pull request, and nothing documented that
  // moves one in or out of draft, so neither is offered rather than failing when pressed.
  actions: ["merge", "close"],
  mergeMethods: ["merge", "squash", "rebase"],
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
};

/** The failures that mean the credentials are the problem, rather than one request. */
function reasonFor(
  error: BitbucketPullRequestApi.BitbucketPullRequestApiError,
): PullRequestProviderError["reason"] {
  // Bitbucket is read over HTTP with credentials from the environment, so there is no tool to be
  // missing: unusable always means the credentials are absent or refused.
  if (error._tag === "BitbucketResponseError" && (error.status === 401 || error.status === 403)) {
    return "unauthenticated";
  }
  return "failed";
}

function toChangeRequest(pullRequest: BitbucketPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    // Line counts are a separate read, which only the detail is worth spending on.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Bitbucket has no labels on a pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

  const fail =
    (operation: string) => (error: BitbucketPullRequestApi.BitbucketPullRequestApiError) =>
      new PullRequestProviderError({
        provider: "bitbucket",
        operation,
        reason: reasonFor(error),
        // Every Bitbucket failure states its own fact; this names the operation around it, so
        // the two do not stack into "failed in x: failed in y: ...".
        detail: error.detail,
        cause: error,
      });

  const provider: PullRequestProviderApi = {
    kind: "bitbucket",
    capabilities: CAPABILITIES,

    // Bitbucket credentials come from the server's environment rather than a checkout, so the
    // account is the same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          limit: input.limit,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
          })),
        ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      // Bitbucket spreads a pull request over six endpoints, so they are read together.
      return Effect.all(
        [
          api.getPullRequest(target),
          api.getDiffStat(target),
          // Each of these is worth degrading for: none is a reason to blank a pull request that
          // was read successfully. An unread conversation counts as truncated so it does not
          // present as one with no comments.
          api.getMergeability(target).pipe(Effect.orElseSucceed(() => "unknown" as const)),
          api
            .listComments(target)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], threads: [], truncated: true }))),
          api.listCommits(target).pipe(Effect.orElseSucceed(() => [])),
          api.listChecks(target).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: 6 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([
            pullRequest,
            diffStat,
            mergeability,
            comments,
            commits,
            checks,
          ]): ProviderChangeRequestDetail => ({
            ...toChangeRequest(pullRequest),
            mergeability,
            additions: diffStat.additions,
            deletions: diffStat.deletions,
            changedFiles: diffStat.changedFiles,
            body: pullRequest.body,
            mergedAt: pullRequest.state === "merged" ? pullRequest.updatedAt : null,
            closedAt: pullRequest.state === "closed" ? pullRequest.updatedAt : null,
            reviewers: pullRequest.reviewers,
            checks,
            comments: [...comments.comments, ...pullRequest.reviews].toSorted((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            ),
            commentsTruncated: comments.truncated,
            reviewThreads: comments.threads,
            commits,
            // Bitbucket publishes no per-repository list of allowed strategies, so the ones it
            // supports are all offered and a strategy the repository forbids fails on merge.
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          }),
        ),
      );
    },

    // `/diff` answers with the whole patch and pages nothing, so the first slice is the last.
    getDiff: (input) =>
      api.getPullRequestDiff({ repository: input.repository, number: input.number }).pipe(
        Effect.mapError(fail("getDiff")),
        Effect.map((diff) => ({ ...diff, nextCursor: null })),
      ),

    runAction: (input) =>
      api
        .runAction({
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) =>
      api
        .comment({ repository: input.repository, number: input.number, body: input.body })
        .pipe(Effect.mapError(fail("comment"))),

    submitReview: (input) =>
      api
        .submitReview({
          repository: input.repository,
          number: input.number,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        })
        .pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      api
        .replyToComment({
          repository: input.repository,
          number: input.number,
          commentId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setThreadResolution: (input) =>
      api
        .setCommentResolution({
          repository: input.repository,
          number: input.number,
          commentId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
