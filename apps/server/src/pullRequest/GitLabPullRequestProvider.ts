import * as Effect from "effect/Effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  // GitLab offers all three, though a project settles on one; `mergeCapabilities` narrows it.
  mergeMethods: ["merge", "squash", "rebase"],
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // No "changes requested": GitLab has approval and unresolved discussions, and nothing that
    // says a merge request has been reviewed and rejected.
    verdicts: ["comment", "approve"],
  },
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "GitLabCliUnavailableError") return "missing-tool";
  if (error._tag === "GitLabCliAuthenticationError") return "unauthenticated";
  return "failed";
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "gitlab",
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "gitlab",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerUsername({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listMergeRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
        })
        .pipe(Effect.mapError(fail("listChangeRequests"))),

    getChangeRequest: (input) =>
      // GitLab splits a merge request across four endpoints, so they are read together.
      Effect.all(
        [
          cli.getMergeRequestDetail(input),
          cli.getProjectMergeCapabilities({ cwd: input.cwd, repository: input.repository }),
          // The conversation and the commit list are worth degrading for: neither is reason
          // to blank a merge request that was read successfully. An unread conversation counts
          // as truncated, so it does not present as one with no comments.
          cli
            .listNotes(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: true }))),
          cli.listCommits(input).pipe(Effect.orElseSucceed(() => [])),
          cli
            .listDiscussions(input)
            .pipe(Effect.orElseSucceed(() => ({ threads: [], truncated: true }))),
        ],
        { concurrency: 5 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([
            mergeRequest,
            mergeCapabilities,
            notes,
            commits,
            discussions,
          ]): ProviderChangeRequestDetail => ({
            ...mergeRequest,
            comments: notes.comments,
            commentsTruncated: notes.truncated || discussions.truncated,
            reviewThreads: discussions.threads,
            commits,
            mergeCapabilities,
          }),
        ),
      ),

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    runAction: (input) =>
      cli
        .runMergeRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnMergeRequest(input).pipe(Effect.mapError(fail("comment"))),

    submitReview: (input) => cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToDiscussion({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setThreadResolution: (input) =>
      cli
        .setDiscussionResolution({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
