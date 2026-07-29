import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import {
  PullRequestProviderRegistry,
  makeRegistry,
  providerError,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
  type PullRequestProviderError,
} from "./PullRequestProvider.ts";

/** `gh pr view --json comments` returns one page; a full page means more exist on GitHub. */
const CONVERSATION_PAGE_SIZE = 100;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  inlineComments: true,
  draft: true,
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
    providerError("github", operation, reasonFor(error), error.detail, error);

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
          // GraphQL hiccup must not blank the whole detail, so it degrades to "none".
          cli
            .listReviewThreadComments(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: false }))),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([pullRequest, mergeCapabilities, reviewThreads]): ProviderChangeRequestDetail => ({
            ...pullRequest,
            reviewers: pullRequest.reviewRequestLogins.map((login) => ({ login, name: null })),
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

/** Registry holding the providers this build ships. */
export const registryLayer = Layer.effect(
  PullRequestProviderRegistry,
  Effect.map(make, (github) => makeRegistry([github])),
);
