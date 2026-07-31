import * as Effect from "effect/Effect";
import type { PullRequestActor, PullRequestCapabilities } from "@t3tools/contracts";

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
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "GitHubCliUnavailableError") return "missing-tool";
  if (error._tag === "GitHubCliAuthenticationError") return "unauthenticated";
  return "failed";
}

/**
 * `gh pr view --json` reports no avatar for anyone, so the ones the GraphQL read collected are
 * applied here by login. An actor already carrying one keeps it.
 */
function withAvatar(
  actor: PullRequestActor | null,
  avatarsByLogin: ReadonlyMap<string, string>,
): PullRequestActor | null {
  if (actor === null || actor.avatarUrl !== null) return actor;
  const avatarUrl = avatarsByLogin.get(actor.login) ?? null;
  return avatarUrl === null ? actor : { ...actor, avatarUrl };
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
          host: input.host,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.flatMap((page) =>
            cli
              .listActorAvatars({
                cwd: input.cwd,
                repository: input.repository,
                host: input.host,
                ids: [...new Set(page.items.flatMap((item) => item.authorId ?? []))],
              })
              // A listing without faces is still a listing, so a failed lookup falls back to
              // the initials rather than taking the rows down with it.
              .pipe(
                Effect.orElseSucceed(() => new Map<string, string>()),
                Effect.map((avatarsByLogin) => ({
                  ...page,
                  items: page.items.map((item) => ({
                    ...item,
                    author: withAvatar(item.author, avatarsByLogin),
                  })),
                })),
              ),
          ),
        ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          cli.getPullRequestDetail(input),
          cli.getRepositoryMergeCapabilities({
            cwd: input.cwd,
            repository: input.repository,
            host: input.host,
          }),
          // Line comments live on review threads, which `gh pr view --json` cannot reach. A
          // GraphQL hiccup must not blank the whole detail, so it degrades to "none" — marked
          // truncated, because an unread thread is a missing comment, not an absent one.
          cli.listReviewThreadComments(input).pipe(
            Effect.orElseSucceed(() => ({
              comments: [],
              reviewThreads: [],
              truncated: true,
              reviewers: [],
              avatarsByLogin: new Map<string, string>(),
            })),
          ),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([pullRequest, mergeCapabilities, reviewThreads]): ProviderChangeRequestDetail => ({
            ...pullRequest,
            author: withAvatar(pullRequest.author, reviewThreads.avatarsByLogin),
            // From the review itself rather than from the listing's outstanding requests, which
            // hold no avatar and drop anyone who has already reviewed.
            reviewers: reviewThreads.reviewers,
            comments: [...pullRequest.comments, ...reviewThreads.comments]
              .map((comment) => ({
                ...comment,
                author: withAvatar(comment.author, reviewThreads.avatarsByLogin),
              }))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            commentsTruncated:
              pullRequest.comments.length >= CONVERSATION_PAGE_SIZE || reviewThreads.truncated,
            reviewThreads: reviewThreads.reviewThreads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                author: withAvatar(comment.author, reviewThreads.avatarsByLogin),
              })),
            })),
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
          host: input.host,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnPullRequest(input).pipe(Effect.mapError(fail("comment"))),

    submitReview: (input) => cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToReviewThread({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setThreadResolution: (input) =>
      cli
        .setReviewThreadResolution({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
