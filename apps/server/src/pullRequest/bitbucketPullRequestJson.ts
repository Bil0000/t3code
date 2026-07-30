import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * Bitbucket's enums are decoded as plain strings and normalized here, in the same tolerant
 * style as the GitHub and GitLab decoders: a new pull request state or build status must not
 * fail a whole payload.
 */
const RawUserSchema = Schema.Struct({
  /** Absent on an app account, which is why `display_name` has to stand in for it. */
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Required, and required to be non-empty: the wire contract will not carry a change request
 * without a branch or a link, so a row missing one is skipped rather than breaking the response
 * it travels in.
 */
const RawBranchSchema = Schema.Struct({
  branch: Schema.Struct({ name: TrimmedNonEmptyString }),
});

const RawLinkSchema = Schema.Struct({ href: Schema.optional(Schema.String) });

const RawPullRequestSchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  source: RawBranchSchema,
  destination: RawBranchSchema,
  created_on: Schema.String,
  updated_on: Schema.String,
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
  participants: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: Schema.optional(Schema.NullOr(RawUserSchema)),
          role: Schema.optional(Schema.NullOr(Schema.String)),
          approved: Schema.optional(Schema.Boolean),
          state: Schema.optional(Schema.NullOr(Schema.String)),
          participated_on: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  links: Schema.Struct({ html: Schema.Struct({ href: TrimmedNonEmptyString }) }),
});

const RawPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  /** A total count, which Bitbucket omits on some endpoints. */
  size: Schema.optional(Schema.NullOr(Schema.Int)),
  /** Present only while a further page exists. */
  next: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.String) }))),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_on: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  /** A comment still being drafted by its author. */
  pending: Schema.optional(Schema.Boolean),
  inline: Schema.optional(
    Schema.NullOr(Schema.Struct({ path: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  links: Schema.optional(
    Schema.NullOr(Schema.Struct({ html: Schema.optional(Schema.NullOr(RawLinkSchema)) })),
  ),
});

const RawCommitSchema = Schema.Struct({
  hash: Schema.String,
  message: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawStatusSchema = Schema.Struct({
  key: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawDiffstatSchema = Schema.Struct({
  lines_added: Schema.optional(Schema.NullOr(Schema.Int)),
  lines_removed: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawViewerSchema = Schema.Struct({
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface BitbucketPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /**
   * Bitbucket reports no conflict state on a pull request, so the list leaves it unknown. The
   * detail read asks the conflicts endpoint, which does answer.
   */
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /** Approvals and change requests, which Bitbucket keeps on its participants. */
  readonly reviews: ReadonlyArray<PullRequestComment>;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Bitbucket stamps times as `+00:00` with microseconds. The page sorts change requests from
 * every host against each other as plain strings, so they are normalized to the same `Z` form
 * the other hosts already use.
 */
function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

/** An app account has no nickname, so the display name is the only handle it has. */
function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.nickname) ?? trimmed(raw?.display_name);
  return login === null ? null : { login, name: trimmed(raw?.display_name) };
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "DECLINED":
    case "SUPERSEDED":
      return "closed";
    default:
      return "open";
  }
}

function toBuildStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "STOPPED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * A participant who has voted is the closest Bitbucket has to a review, so it reads as one in
 * the conversation. Participants who have only been added carry no verdict and are skipped.
 */
function toReviews(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): ReadonlyArray<PullRequestComment> {
  return (raw.participants ?? []).flatMap((participant): ReadonlyArray<PullRequestComment> => {
    const author = toActor(participant.user);
    const votedAt = trimmed(participant.participated_on);
    const reviewState =
      trimmed(participant.state) ?? (participant.approved === true ? "approved" : null);
    if (author === null || votedAt === null || reviewState === null) return [];
    return [
      {
        id: `${raw.id}:${author.login}`,
        kind: "review",
        author,
        body: "",
        createdAt: toIsoUtc(votedAt),
        url: null,
        path: null,
        reviewState,
      },
    ];
  });
}

function toPullRequest(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): BitbucketPullRequest {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    author: toActor(raw.author),
    headBranch: raw.source.branch.name,
    baseBranch: raw.destination.branch.name,
    state: toState(raw),
    isDraft: raw.draft ?? false,
    mergeability: "unknown",
    createdAt: toIsoUtc(raw.created_on),
    updatedAt: toIsoUtc(raw.updated_on),
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    reviews: toReviews(raw),
  };
}

const decodePage = decodeJsonResult(RawPageSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeCommentEntry = Schema.decodeUnknownExit(RawCommentSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeStatusEntry = Schema.decodeUnknownExit(RawStatusSchema);
const decodeDiffstatEntry = Schema.decodeUnknownExit(RawDiffstatSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeConflicts = decodeJsonResult(RawPageSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface BitbucketPage<A> {
  readonly items: ReadonlyArray<A>;
  /** The whole URL of the next page, which Bitbucket sends rather than an offset. */
  readonly next: string | null;
}

/** Malformed entries are skipped rather than failing the page, as on the other hosts. */
export function decodePullRequestPageJson(
  raw: string,
): Result.Result<BitbucketPage<BitbucketPullRequest>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: BitbucketPullRequest[] = [];
  for (const entry of decoded.success.values) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toPullRequest(item.value));
    }
  }
  return Result.succeed({ items, next: trimmed(decoded.success.next) });
}

export function decodePullRequestJson(
  raw: string,
): Result.Result<BitbucketPullRequest, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.nickname) ?? trimmed(decoded.success.display_name))
    : Result.fail(decoded.failure);
}

export interface BitbucketComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly next: string | null;
}

/**
 * Deleted comments and ones their author has not posted yet carry nothing to show. A comment
 * pinned to a file is a line-level review comment, which is what that kind means.
 */
export function decodeCommentsJson(raw: string): Result.Result<BitbucketComments, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  for (const entry of decoded.success.values) {
    const decodedComment = decodeCommentEntry(entry);
    if (Exit.isFailure(decodedComment)) continue;
    const comment = decodedComment.value;
    if (comment.deleted === true || comment.pending === true) continue;
    const body = comment.content?.raw ?? "";
    if (body.trim().length === 0) continue;
    const path = trimmed(comment.inline?.path);
    comments.push({
      id: String(comment.id),
      kind: path === null ? "issue-comment" : "review-comment",
      author: toActor(comment.user),
      body,
      createdAt: toIsoUtc(comment.created_on),
      url: trimmed(comment.links?.html?.href),
      path,
      reviewState: null,
    });
  }
  return Result.succeed({ comments, next: trimmed(decoded.success.next) });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCommit>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of decoded.success.values) {
    const decodedCommit = decodeCommitEntry(entry);
    if (Exit.isFailure(decodedCommit)) continue;
    const commit = decodedCommit.value;
    const committedDate = trimmed(commit.date);
    if (committedDate === null) continue;
    commits.push({
      oid: commit.hash,
      messageHeadline: (commit.message ?? "").split("\n")[0] ?? "",
      committedDate: toIsoUtc(committedDate),
    });
  }
  // Bitbucket lists a pull request's commits newest first; the timeline reads oldest first.
  return Result.succeed(commits.toReversed());
}

export function decodeStatusesJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCheck>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const checks: PullRequestCheck[] = [];
  for (const entry of decoded.success.values) {
    const decodedStatus = decodeStatusEntry(entry);
    if (Exit.isFailure(decodedStatus)) continue;
    const status = decodedStatus.value;
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (name === null) continue;
    checks.push({
      name,
      status: toBuildStatus(status.state),
      description: trimmed(status.description),
      url: trimmed(status.url),
    });
  }
  return Result.succeed(checks);
}

export interface BitbucketDiffStat {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** One entry per changed file, each carrying that file's line counts. */
export function decodeDiffstatJson(raw: string): Result.Result<BitbucketDiffStat, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const entry of decoded.success.values) {
    const decodedStat = decodeDiffstatEntry(entry);
    if (Exit.isFailure(decodedStat)) continue;
    additions += decodedStat.value.lines_added ?? 0;
    deletions += decodedStat.value.lines_removed ?? 0;
    changedFiles += 1;
  }
  return Result.succeed({ additions, deletions, changedFiles });
}

/**
 * The conflicts endpoint answers with one entry per conflicting path, so an empty page is the
 * only statement Bitbucket makes that a pull request merges cleanly.
 */
export function decodeConflictsJson(
  raw: string,
): Result.Result<PullRequestMergeability, DecodeFailure> {
  const decoded = decodeConflicts(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.values.length === 0 ? "mergeable" : "conflicting")
    : Result.fail(decoded.failure);
}
