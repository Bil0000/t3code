import * as Effect from "effect/Effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { AzureDevOpsPullRequest } from "./azureDevOpsPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  // `az repos pr` has no diff command, and the REST route reports changed files without their
  // contents, so there is no patch to show. The Code tab is hidden rather than empty.
  diff: false,
  // Reading a conversation is a plain REST read, but posting one is not something this can
  // claim without having run it, so the composer stays hidden.
  comment: false,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  // Azure squashes as a completion option; it has no rebase strategy of its own.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at all.
  search: false,
  // With no patch to show there are no lines to write against, so nothing here is offered.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "AzureDevOpsCliUnavailableError") return "missing-tool";
  if (error._tag === "AzureDevOpsCliAuthenticationError") return "unauthenticated";
  return "failed";
}

function toChangeRequest(pullRequest: AzureDevOpsPullRequest): ProviderChangeRequest {
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
    // Azure reports no line counts on a pull request, and with no patch to read there is
    // nothing to count them from either.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Azure keeps labels on work items rather than on the pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

  const fail =
    (operation: string) => (error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError) =>
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        reason: reasonFor(error),
        detail: error.detail,
        cause: error,
      });

  /** Refuses what the capabilities already say this host cannot do. */
  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        reason: "failed",
        detail: "Azure DevOps reviews cannot be written from here yet.",
      }),
    );

  const provider: PullRequestProviderApi = {
    kind: "azure-devops",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    // `input.query` is deliberately dropped: `az repos pr list` filters by status, creator,
    // reviewer and branch, and has nothing that matches text. Sending it as one of those would
    // narrow by the wrong thing, so the page comes back unnarrowed and the caller filters it.
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
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
          })),
        ),

    getChangeRequest: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequest")),
        // The conversation hangs off a url the pull request itself reports, so it is read after
        // rather than alongside. A thread read that fails degrades to none, marked truncated so
        // it does not present as a pull request nobody has commented on.
        Effect.flatMap((pullRequest) =>
          (pullRequest.threadsUrl === null
            ? Effect.succeed({ comments: [], truncated: true })
            : cli.listThreads({ cwd: input.cwd, threadsUrl: pullRequest.threadsUrl }).pipe(
                Effect.map((comments) => ({ comments, truncated: false })),
                Effect.orElseSucceed(() => ({ comments: [], truncated: true })),
              )
          ).pipe(
            Effect.map(
              (conversation): ProviderChangeRequestDetail => ({
                ...toChangeRequest(pullRequest),
                body: pullRequest.body,
                changedFiles: 0,
                mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
                closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
                reviewers: pullRequest.reviewers,
                // Azure reports its gates as branch policy evaluations, which are a separate
                // read this does not make yet.
                checks: [],
                comments: conversation.comments,
                commentsTruncated: conversation.truncated,
                // No patch to pin a conversation to, so nothing here is anchored to a line.
                reviewThreads: [],
                // `az repos pr show` carries no commit list.
                commits: [],
                // Which strategies a repository allows lives in its branch policies, so the two
                // Azure supports are offered and one the policy forbids fails on completion.
                mergeCapabilities: { merge: true, squash: true, rebase: false },
              }),
            ),
          ),
        ),
      ),

    // Never called: `capabilities.diff` is false, and the service refuses a diff without it.
    getDiff: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "azure-devops",
          operation: "getDiff",
          reason: "failed",
          detail: "Azure DevOps cannot produce a patch for a pull request.",
        }),
      ),

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    // Never called: `capabilities.comment` is false, and the service refuses a comment without it.
    comment: () => unsupported("comment"),

    // Declared unsupported above, so the service refuses these before a provider is reached.
    // They exist because every provider answers the whole port.
    submitReview: () => unsupported("submitReview"),

    replyToThread: () => unsupported("replyToThread"),

    setThreadResolution: () => unsupported("setThreadResolution"),
  };

  return provider;
});
