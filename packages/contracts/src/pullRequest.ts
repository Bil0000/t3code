import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

/**
 * What a listing asks for, which is the three states a change request can be in plus the option
 * to span them. Separate from `PullRequestState` because a change request is never "all" — only
 * a request for one can be.
 */
export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals(["merge", "ready", "draft", "close", "reopen"]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  /** Null where a host does not report one, which is what the initials fall back to. */
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestComment = typeof PullRequestComment.Type;

/**
 * Which file a diff line belongs to: `left` is the version before the change, `right` the
 * version after. A comment has to name one, because a unified diff shows both at once and the
 * same line number means two different lines.
 */
export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

/** What submitting a review says about the change, beyond the words in it. */
export const PullRequestReviewVerdict = Schema.Literals(["comment", "approve", "request-changes"]);
export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type;

export const PullRequestThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestThreadComment = typeof PullRequestThreadComment.Type;

/**
 * A conversation anchored to a line of the diff. The detail carries these alongside `comments`
 * rather than instead of them: the timeline wants one flat, chronological list, and the diff
 * wants whole threads pinned to their line — the same remarks, read two different ways.
 */
export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  /** Null when the host anchors the thread to a file rather than to a line. */
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  isResolved: Schema.Boolean,
  /**
   * The line the thread was written against is no longer in the diff, so it cannot be shown
   * against the code. Such a thread is listed separately rather than pinned to the wrong line.
   */
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestThreadComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

/**
 * What a provider can actually do, so a surface can hide what is missing rather than offer an
 * action that would fail. Every provider fills this in for itself; nothing is assumed.
 *
 * Hosts differ more than they look: Azure DevOps exposes no patch through its CLI, and
 * Bitbucket has no endpoint that reopens a declined pull request. Both would otherwise be dead
 * buttons.
 */
/**
 * What a host can do with a review, which is where the four differ most. GitLab has no way to
 * say "changes requested", and Azure DevOps exposes no diff through its CLI, so it has no lines
 * to write against at all.
 */
export const PullRequestReviewCapabilities = Schema.Struct({
  /** A new comment can be anchored to a line of the diff. */
  inlineComment: Schema.Boolean,
  /** An existing thread can be replied to. */
  reply: Schema.Boolean,
  /** A thread can be marked resolved, and unresolved again. */
  resolve: Schema.Boolean,
  /** The verdicts a submitted review can carry. Empty means reviews cannot be submitted. */
  verdicts: Schema.Array(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

export const PullRequestCapabilities = Schema.Struct({
  /** A unified patch can be fetched for the change request. */
  diff: Schema.Boolean,
  /** A comment can be posted, and the conversation read back. */
  comment: Schema.Boolean,
  /** The actions this host can carry out; anything absent is never offered. */
  actions: Schema.Array(PullRequestAction),
  /** Merge strategies the provider itself offers, before repository settings narrow them. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  review: PullRequestReviewCapabilities,
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  /**
   * The host below which `repository` is addressed, so the same provider kind can serve more
   * than one account — github.com and a GitHub Enterprise install are different identities.
   */
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  viewerReviewRequested: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  involvement: Schema.optional(PullRequestInvolvement),
  projectId: Schema.optional(ProjectId),
  /** Narrows the listing to one host. Absent means every configured provider. */
  provider: Schema.optional(SourceControlProviderKind),
  /** Rows to return per repository. The page raises it to load further results. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

/**
 * A provider the workspace has projects on, and whether it can be read right now. Drives the
 * provider switcher and explains projects the list leaves out.
 */
export const PullRequestProviderSummary = Schema.Struct({
  kind: SourceControlProviderKind,
  projectCount: PositiveInt,
  /** False when the provider's CLI or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestProviderSummary = typeof PullRequestProviderSummary.Type;

/** One project whose repository could not be read; healthy projects still return entries. */
export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListResult = Schema.Struct({
  /**
   * The signed-in account per host, which is what involvement filtering compares. Keyed by
   * host rather than by provider kind: two GitHub hosts are two accounts. A host that could
   * not be read is absent rather than present-and-undefined, because an open-keyed record
   * cannot carry an optional value through the JSON codec.
   */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(PullRequestProviderSummary),
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestListProjectError),
  /** At least one repository hit the per-repository listing cap. */
  truncated: Schema.Boolean,
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

export const PullRequestDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  capabilities: PullRequestCapabilities,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
  reviewThreads: Schema.Array(PullRequestReviewThread),
  commits: Schema.Array(PullRequestCommit),
  mergeCapabilities: PullRequestMergeCapabilities,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

// Not trimmed: the body is markdown, where leading spaces open a code block and two trailing
// spaces are a line break. GitHub rejects bodies past 65536 characters, so that bound is
// enforced here to keep oversized payloads off the wire and out of subprocess plumbing; the
// service rejects a body that is only whitespace.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: CommentBody,
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

/** One remark in a review that has not been sent yet, anchored to a line of the diff. */
export const PullRequestReviewCommentDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  side: PullRequestDiffSide,
  body: CommentBody,
});
export type PullRequestReviewCommentDraft = typeof PullRequestReviewCommentDraft.Type;

/**
 * A whole review, sent in one go. The line comments travel with the verdict rather than being
 * posted as they are written, so a half-finished review is never visible to anyone else — and
 * so hosts with no notion of a pending review behave the same as the ones that have it.
 */
export const PullRequestSubmitReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  verdict: PullRequestReviewVerdict,
  /** The review's own words. May be empty, which is how an approval with no remarks is sent. */
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PullRequestReviewCommentDraft),
});
export type PullRequestSubmitReviewInput = typeof PullRequestSubmitReviewInput.Type;

export const PullRequestThreadReplyInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  body: CommentBody,
});
export type PullRequestThreadReplyInput = typeof PullRequestThreadReplyInput.Type;

export const PullRequestThreadResolutionInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  resolved: Schema.Boolean,
});
export type PullRequestThreadResolutionInput = typeof PullRequestThreadResolutionInput.Type;

export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

/**
 * What each host needs before it can be read, so a failure names the fix rather than the
 * symptom. Bitbucket is credentials on the server rather than a signed-in CLI, which is why
 * these are whole sentences instead of a tool name to interpolate.
 */
const PROVIDER_REQUIREMENT: Partial<
  Record<SourceControlProviderKind, { readonly missing: string; readonly unauthenticated: string }>
> = {
  github: {
    missing:
      "GitHub CLI (`gh`) is required to browse change requests on this host. Install it from https://cli.github.com/ and reload.",
    unauthenticated: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  },
  gitlab: {
    missing:
      "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
    unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
  },
  "azure-devops": {
    missing:
      "Azure CLI (`az`) with the Azure DevOps extension is required. Install `az`, then run `az extension add --name azure-devops`.",
    unauthenticated: "Azure CLI is not signed in. Run `az login` and retry.",
  },
  bitbucket: {
    missing:
      "Bitbucket needs API credentials on the server. Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN, or T3CODE_BITBUCKET_ACCESS_TOKEN.",
    unauthenticated:
      "Bitbucket rejected the configured credentials. Check T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN.",
  },
};

/**
 * What a host needs before it can be read, as a sentence to show wherever that host is reported
 * as unusable — the whole page when nothing can be read, and one entry in the host switcher when
 * only that host cannot. Null when the reason is not about setting a host up.
 */
export function pullRequestProviderRequirement(
  provider: SourceControlProviderKind,
  reason: PullRequestUnavailableReason,
): string | null {
  const requirement = PROVIDER_REQUIREMENT[provider];
  if (requirement === undefined) return null;
  switch (reason) {
    case "cli-missing":
      return requirement.missing;
    case "cli-unauthenticated":
      return requirement.unauthenticated;
    case "provider-unsupported":
      return null;
  }
}

/**
 * The feature is switched off entirely. The message is derived from `reason` and the host
 * rather than from whatever the CLI printed, so it stays a stable sentence the UI can show
 * as-is; the underlying failure travels in `cause` (absent for `provider-unsupported`, which
 * has none).
 */
export class PullRequestUnavailableError extends Schema.TaggedErrorClass<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const requirement =
      this.provider === undefined ? undefined : PROVIDER_REQUIREMENT[this.provider];
    switch (this.reason) {
      case "cli-missing":
        return (
          requirement?.missing ?? "The tool this host is read through is not installed or set up."
        );
      case "cli-unauthenticated":
        return requirement?.unauthenticated ?? "This host has no working credentials.";
      case "provider-unsupported":
        return "Change requests cannot be browsed for this project's host yet.";
    }
  }
}

export class PullRequestOperationError extends Schema.TaggedErrorClass<PullRequestOperationError>()(
  "PullRequestOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pull request operation ${this.operation} failed: ${this.detail}`;
  }
}
