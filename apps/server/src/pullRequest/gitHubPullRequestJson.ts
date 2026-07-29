import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * Enum-ish GitHub CLI fields are decoded as plain strings and normalized here: a `gh`
 * release that adds a conclusion or a review state must not fail the whole payload.
 */
const RawActorSchema = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawListItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.Int),
  deletions: Schema.optional(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewRequests: Schema.optional(Schema.Array(RawReviewRequestSchema)),
  labels: Schema.optional(Schema.Array(RawLabelSchema)),
});

const RawCheckSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.String),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommitSchema = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.optional(Schema.String),
  committedDate: Schema.String,
});

const RawDetailSchema = Schema.Struct({
  ...RawListItemSchema.fields,
  body: Schema.optional(Schema.String),
  changedFiles: Schema.optional(Schema.Int),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawCheckSchema))),
  comments: Schema.optional(Schema.Array(RawCommentSchema)),
  reviews: Schema.optional(Schema.Array(RawReviewSchema)),
  commits: Schema.optional(Schema.Array(RawCommitSchema)),
});

/** `gh pr view --json` cannot reach review threads, so they come from the GraphQL API. */
const RawReviewThreadsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          totalCount: Schema.optional(Schema.Int),
          nodes: Schema.Array(
            Schema.Struct({
              isResolved: Schema.optional(Schema.Boolean),
              path: Schema.optional(Schema.NullOr(Schema.String)),
              comments: Schema.Struct({ nodes: Schema.Array(RawCommentSchema) }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** Requested together, so a response missing any of them fails rather than defaulting open:
 *  guessing `true` would offer a merge method the repository forbids. */
const RawMergeCapabilitiesSchema = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
});

export const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,author,headRefName,baseRefName,state,isDraft,mergeable,additions,deletions,createdAt,updatedAt,mergedAt,reviewRequests,labels";

export const PULL_REQUEST_DETAIL_JSON_FIELDS = `${PULL_REQUEST_LIST_JSON_FIELDS},body,changedFiles,closedAt,statusCheckRollup,comments,reviews,commits`;

/** Root comments of the first page of review threads; deeper replies stay on GitHub. */
export const REVIEW_THREADS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        totalCount
        nodes {
          isResolved
          path
          comments(first: 1) {
            nodes { id author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

export const REPOSITORY_MERGE_CAPABILITIES_JSON_FIELDS =
  "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed";

export interface GitHubPullRequestListItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestListItem {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: Schema.Schema.Type<typeof RawActorSchema> | null | undefined) {
  const login = trimmed(raw?.login);
  return login === null ? null : { login, name: trimmed(raw?.name) };
}

function toState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  if (trimmed(raw.mergedAt) !== null) return "merged";
  const state = raw.state?.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toLabels(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawLabelSchema>> | undefined,
): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null ? [] : [{ name, color: trimmed(label.color) }];
  });
}

/**
 * User review requests only. A team request carries a slug, and the viewer check compares
 * these against a login, so keeping slugs here would let an unrelated team read as the
 * viewer. Team-routed requests need GitHub's review-requested search to resolve.
 */
function toReviewRequestLogins(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawReviewRequestSchema>> | undefined,
): ReadonlyArray<string> {
  return (raw ?? []).flatMap((request) => {
    const login = trimmed(request.login);
    return login === null ? [] : [login];
  });
}

function toCheckStatus(raw: Schema.Schema.Type<typeof RawCheckSchema>): PullRequestCheckStatus {
  // Commit statuses report a single `state`; check runs report `status` plus a `conclusion`
  // that only exists once the run has completed.
  const status = raw.status?.trim().toUpperCase();
  if (status !== undefined && status !== "COMPLETED" && status !== "") {
    return "pending";
  }
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    // A completed check asking for manual intervention is blocking, not neutral.
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

function toChecks(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawCheckSchema>> | null | undefined,
): ReadonlyArray<PullRequestCheck> {
  return (raw ?? []).flatMap((check) => {
    const name = trimmed(check.name) ?? trimmed(check.context);
    if (name === null) return [];
    return [
      {
        name,
        status: toCheckStatus(check),
        description: trimmed(check.description),
        url: trimmed(check.detailsUrl) ?? trimmed(check.targetUrl),
      },
    ];
  });
}

function toComments(
  raw: Schema.Schema.Type<typeof RawDetailSchema>,
): ReadonlyArray<PullRequestComment> {
  const issueComments = (raw.comments ?? []).map(
    (comment): PullRequestComment => ({
      id: comment.id,
      kind: "issue-comment",
      author: toActor(comment.author),
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      url: trimmed(comment.url),
      path: null,
      reviewState: null,
    }),
  );
  // A review with neither a body nor a state carries nothing to show. One with a state but no
  // body is an approval or a change request, which is the whole event and is kept.
  const reviews = (raw.reviews ?? []).flatMap((review): ReadonlyArray<PullRequestComment> => {
    const submittedAt = trimmed(review.submittedAt);
    const reviewState = trimmed(review.state);
    if (submittedAt === null || ((review.body ?? "").trim().length === 0 && reviewState === null)) {
      return [];
    }
    return [
      {
        id: review.id,
        kind: "review",
        author: toActor(review.author),
        body: review.body ?? "",
        createdAt: submittedAt,
        url: trimmed(review.url),
        path: null,
        reviewState,
      },
    ];
  });
  return [...issueComments, ...reviews].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function toListItem(raw: Schema.Schema.Type<typeof RawListItemSchema>): GitHubPullRequestListItem {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeable),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewRequestLogins: toReviewRequestLogins(raw.reviewRequests),
    labels: toLabels(raw.labels),
  };
}

function toDetail(raw: Schema.Schema.Type<typeof RawDetailSchema>): GitHubPullRequestDetail {
  return {
    ...toListItem(raw),
    body: raw.body ?? "",
    changedFiles: raw.changedFiles ?? 0,
    mergedAt: trimmed(raw.mergedAt),
    closedAt: trimmed(raw.closedAt),
    checks: toChecks(raw.statusCheckRollup),
    comments: toComments(raw),
    commits: (raw.commits ?? []).map((commit) => ({
      oid: commit.oid,
      messageHeadline: commit.messageHeadline ?? "",
      committedDate: commit.committedDate,
    })),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeListEntry = Schema.decodeUnknownExit(RawListItemSchema);
const decodeDetail = decodeJsonResult(RawDetailSchema);
const decodeMergeCapabilities = decodeJsonResult(RawMergeCapabilitiesSchema);
const decodeReviewThreads = decodeJsonResult(RawReviewThreadsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  /** Rows gh returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected pull request
 *  must not blank the whole list. */
export function decodePullRequestListJson(
  raw: string,
): Result.Result<GitHubPullRequestListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitHubPullRequestListItem[] = [];
  for (const entry of decoded.success) {
    const item = decodeListEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toListItem(item.value));
    }
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export function decodePullRequestDetailJson(
  raw: string,
): Result.Result<GitHubPullRequestDetail, DecodeFailure> {
  const decoded = decodeDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toDetail(decoded.success))
    : Result.fail(decoded.failure);
}

export interface GitHubReviewThreadComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly truncated: boolean;
}

/**
 * Unresolved review threads only: a resolved thread is finished work, and surfacing it
 * again would put stale findings into the "fix findings" prompt.
 */
export function decodeReviewThreadsJson(
  raw: string,
): Result.Result<GitHubReviewThreadComments, DecodeFailure> {
  const decoded = decodeReviewThreads(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const threads = decoded.success.data.repository.pullRequest.reviewThreads;
  const comments = threads.nodes.flatMap((thread): ReadonlyArray<PullRequestComment> => {
    const root = thread.comments.nodes[0];
    if (thread.isResolved === true || root === undefined) return [];
    return [
      {
        id: root.id,
        kind: "review-comment",
        author: toActor(root.author),
        body: root.body ?? "",
        createdAt: root.createdAt,
        url: trimmed(root.url),
        path: trimmed(thread.path),
        reviewState: null,
      },
    ];
  });
  return Result.succeed({
    comments,
    truncated: (threads.totalCount ?? threads.nodes.length) > threads.nodes.length,
  });
}

export function decodeRepositoryMergeCapabilitiesJson(
  raw: string,
): Result.Result<PullRequestMergeCapabilities, DecodeFailure> {
  const decoded = decodeMergeCapabilities(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        merge: decoded.success.mergeCommitAllowed,
        squash: decoded.success.squashMergeAllowed,
        rebase: decoded.success.rebaseMergeAllowed,
      })
    : Result.fail(decoded.failure);
}
