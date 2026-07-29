import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals(["merge", "ready", "draft", "close", "reopen"]);
export type PullRequestAction = typeof PullRequestAction.Type;

/** GitHub CLI JSON exposes no avatar URL, so actors render as login plus initials. */
export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
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

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestListEntry = Schema.Struct({
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
  state: PullRequestState,
  involvement: Schema.optional(PullRequestInvolvement),
  projectId: Schema.optional(ProjectId),
  /** Rows to return per repository. The page raises it to load further results. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

/** One project whose repository could not be read; healthy projects still return entries. */
export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListResult = Schema.Struct({
  viewer: Schema.NullOr(TrimmedNonEmptyString),
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

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  // GitHub rejects comment bodies past 65536 characters; enforcing it here keeps oversized
  // payloads off the wire and out of subprocess plumbing entirely.
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

const PULL_REQUEST_UNAVAILABLE_MESSAGES: Record<PullRequestUnavailableReason, string> = {
  "cli-missing":
    "GitHub CLI (`gh`) is required to browse pull requests. Install it from https://cli.github.com/ and reload.",
  "cli-unauthenticated": "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  "provider-unsupported": "Pull requests are only available for projects on GitHub.",
};

/**
 * The feature is switched off entirely. The message is derived from `reason` rather than from
 * whatever the CLI printed, so it stays a stable sentence the UI can show as-is; the
 * underlying failure travels in `cause` (absent for `provider-unsupported`, which has none).
 */
export class PullRequestUnavailableError extends Schema.TaggedErrorClass<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return PULL_REQUEST_UNAVAILABLE_MESSAGES[this.reason];
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
