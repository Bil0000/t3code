import * as Effect from "effect/Effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

/** `gh pr view --json comments` returns one page; a full page means more exist on GitHub. */
const CONVERSATION_PAGE_SIZE = 100;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  mergeMethods: ["merge", "squash", "rebase"],
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "GitHubCliUnavailableError") return "missing-tool";
  if (error._tag === "GitHubCliAuthenticationError") return "unauthenticated";
  return "failed";
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

  const fail = (operation: string) => (error: GitHubPullRequestCli.GitHubPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "github",
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "github",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerLogin({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
        })
        .pipe(Effect.mapError(fail("listChangeRequests"))),

    getChangeRequest: (input) =>
      Effect.all(
        [
          cli.getPullRequestDetail(input),
          cli.getRepositoryMergeCapabilities({ cwd: input.cwd, repository: input.repository }),
          // Line comments live on review threads, which `gh pr view --json` cannot reach. A
          // GraphQL hiccup must not blank the whole detail, so it degrades to "none" — marked
          // truncated, because an unread thread is a missing comment, not an absent one.
          cli
            .listReviewThreadComments(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: true, reviewers: [] }))),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([pullRequest, mergeCapabilities, reviewThreads]): ProviderChangeRequestDetail => ({
            ...pullRequest,
            // From the review itself rather than from the listing's outstanding requests, which
            // hold no avatar and drop anyone who has already reviewed.
            reviewers: reviewThreads.reviewers,
            comments: [...pullRequest.comments, ...reviewThreads.comments].toSorted((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            ),
            commentsTruncated:
              pullRequest.comments.length >= CONVERSATION_PAGE_SIZE || reviewThreads.truncated,
            mergeCapabilities,
          }),
        ),
      ),

    getDiff: (input) => cli.getPullRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnPullRequest(input).pipe(Effect.mapError(fail("comment"))),
  };

  return provider;
});
