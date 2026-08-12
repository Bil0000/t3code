import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  ChangeRequestState,
  IssueAssigneeCandidate,
  IssueComment,
  IssueEvent,
  IssueEventKind,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueState,
  SourceControlActor,
  SourceControlLabel,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * GitLab's REST enums are decoded as plain strings and normalized here: a GitLab release that
 * adds an issue state or a label event action must not fail the whole payload.
 */
const RawUserSchema = Schema.Struct({
  /**
   * GitLab writes an issue's assignees as numeric ids and takes no usernames there, so the id is
   * carried alongside the handle rather than looked up again when an assignment is written.
   */
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawIssueSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  milestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ title: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  user_notes_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  /** True for the notes GitLab writes itself ("closed", "added ~1 label"), which are events. */
  system: Schema.optional(Schema.Boolean),
});

const RawLabelEventSchema = Schema.Struct({
  id: Schema.Int,
  action: Schema.String,
  created_at: Schema.String,
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  /** Null once the label itself has been deleted, which leaves the event with no subject. */
  label: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) }))),
});

const RawLinkedMergeRequestSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  work_in_progress: Schema.optional(Schema.Boolean),
  /** `full` is `group/project!12`, which is the only place the merge request names its project. */
  references: Schema.optional(
    Schema.NullOr(Schema.Struct({ full: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawProjectLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawViewerSchema = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface GitLabIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: SourceControlActor | null;
  readonly state: IssueState;
  /** GitLab records nothing about why an issue was closed, so there is never a reason to report. */
  readonly stateReason: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly assignees: ReadonlyArray<SourceControlActor>;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly milestone: string | null;
  readonly commentCount: number;
}

export interface GitLabIssueDetail extends GitLabIssue {
  readonly body: string;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.username);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatar_url) };
}

function toActors(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawUserSchema>> | null | undefined,
): ReadonlyArray<SourceControlActor> {
  return (raw ?? []).flatMap((user) => {
    const actor = toActor(user);
    return actor === null ? [] : [actor];
  });
}

function toLabels(
  raw: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<SourceControlLabel> {
  // GitLab returns label names only on an issue, so there is no colour to carry.
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label);
    return name === null ? [] : [{ name, color: null }];
  });
}

function toIssue(raw: Schema.Schema.Type<typeof RawIssueSchema>): GitLabIssue {
  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    author: toActor(raw.author),
    // GitLab has exactly the two states, and calls the open one `opened`.
    state: raw.state?.trim().toLowerCase() === "closed" ? "closed" : "open",
    stateReason: null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: trimmed(raw.closed_at),
    assignees: toActors(raw.assignees),
    labels: toLabels(raw.labels),
    milestone: trimmed(raw.milestone?.title),
    commentCount: Math.max(0, raw.user_notes_count ?? 0),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeNoteEntry = Schema.decodeUnknownExit(RawNoteSchema);
const decodeLabelEventEntry = Schema.decodeUnknownExit(RawLabelEventSchema);
const decodeLinkedMergeRequestEntry = Schema.decodeUnknownExit(RawLinkedMergeRequestSchema);
const decodeProjectLabelEntry = Schema.decodeUnknownExit(RawProjectLabelSchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitLabIssueListBatch {
  readonly items: ReadonlyArray<GitLabIssue>;
  /** Zero-based positions of the decoded items in GitLab's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows GitLab returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected issue must not
 *  blank the whole list. */
export function decodeIssueListJson(
  raw: string,
): Result.Result<GitLabIssueListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitLabIssue[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodeIssueEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toIssue(item.value));
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitLabIssueDetail, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ ...toIssue(decoded.success), body: decoded.success.description ?? "" })
    : Result.fail(decoded.failure);
}

/** What a create answered with, which is the only part of a new issue the caller needs back. */
export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ number: decoded.success.iid, url: decoded.success.web_url })
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.username))
    : Result.fail(decoded.failure);
}

/**
 * The change GitLab described in a system note, or null for one that does not map onto a kind of
 * its own. The body is prose GitLab is free to reword, so only the openings that have been stable
 * for years are read, and anything else is dropped rather than guessed at — a timeline missing an
 * entry is better than one asserting the wrong thing happened.
 */
function toSystemEvent(
  body: string,
): { readonly kind: IssueEventKind; readonly detail: string | null } | null {
  const text = body.trim();
  if (text === "closed") return { kind: "closed", detail: null };
  if (text === "reopened") return { kind: "reopened", detail: null };
  if (text === "locked this issue") return { kind: "locked", detail: null };
  if (text === "unlocked this issue") return { kind: "unlocked", detail: null };
  if (text.startsWith("assigned to ")) {
    return {
      kind: "assigned",
      detail: trimmed(text.slice("assigned to ".length).replace(/^@/, "")),
    };
  }
  if (text.startsWith("unassigned ")) {
    return {
      kind: "unassigned",
      detail: trimmed(text.slice("unassigned ".length).replace(/^@/, "")),
    };
  }
  if (text.startsWith("mentioned in ")) {
    return { kind: "referenced", detail: trimmed(text.slice("mentioned in ".length)) };
  }
  if (text.startsWith("changed title")) {
    // GitLab marks the new title with its own inline-diff braces; without them the rename still
    // belongs on the timeline, it just has no subject to name.
    return { kind: "renamed", detail: trimmed(/\{\+(.+)\+\}/.exec(text)?.[1]) };
  }
  if (text.startsWith("changed milestone to ")) {
    const milestone = text.slice("changed milestone to ".length).trim();
    return {
      kind: "milestoned",
      detail: trimmed(milestone.replace(/^%/, "").replace(/^"|"$/g, "")),
    };
  }
  // A label note names its labels by id ("added ~7 label"), which is why labellings are read from
  // `/resource_label_events` instead; dropping them here keeps the timeline from showing both.
  return null;
}

export interface GitLabIssueNotes {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly events: ReadonlyArray<IssueEvent>;
  /** Notes GitLab returned, counted before decoding, so a skipped note cannot hide a next page. */
  readonly rawCount: number;
}

/**
 * One page of an issue's notes, split into what people wrote and what GitLab recorded. Both come
 * from the same read because GitLab keeps them in the same place, and the raw count comes back
 * alongside: a caller cannot tell "no more notes" from "a page of activity entries" without it.
 */
export function decodeIssueNotesJson(raw: string): Result.Result<GitLabIssueNotes, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: IssueComment[] = [];
  const events: IssueEvent[] = [];
  for (const entry of decoded.success) {
    const note = decodeNoteEntry(entry);
    if (Exit.isFailure(note)) continue;
    const value = note.value;
    const body = value.body ?? "";
    if (value.system === true) {
      const event = toSystemEvent(body);
      if (event === null) continue;
      events.push({
        // Notes and label events are numbered separately, so each carries where it came from.
        id: `note-${value.id}`,
        kind: event.kind,
        actor: toActor(value.author),
        createdAt: value.created_at,
        detail: event.detail,
      });
      continue;
    }
    if (body.trim().length === 0) continue;
    comments.push({
      id: String(value.id),
      author: toActor(value.author),
      body,
      createdAt: value.created_at,
      url: null,
    });
  }
  return Result.succeed({ comments, events, rawCount: decoded.success.length });
}

export interface GitLabIssueLabelEvents {
  readonly events: ReadonlyArray<IssueEvent>;
  readonly rawCount: number;
}

/** Labellings, which GitLab reports properly here and only by label id in the notes. */
export function decodeLabelEventsJson(
  raw: string,
): Result.Result<GitLabIssueLabelEvents, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const events: IssueEvent[] = [];
  for (const entry of decoded.success) {
    const event = decodeLabelEventEntry(entry);
    if (Exit.isFailure(event)) continue;
    const action = event.value.action.trim().toLowerCase();
    if (action !== "add" && action !== "remove") continue;
    events.push({
      id: `label-${event.value.id}`,
      kind: action === "add" ? "labeled" : "unlabeled",
      actor: toActor(event.value.user),
      createdAt: event.value.created_at,
      // A label deleted since the event leaves the labelling with nothing to name.
      detail: trimmed(event.value.label?.name),
    });
  }
  return Result.succeed({ events, rawCount: decoded.success.length });
}

function toChangeRequestState(value: string | null | undefined): ChangeRequestState {
  switch (value?.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      // `locked` is an open merge request whose discussion is locked.
      return "open";
  }
}

/**
 * The merge requests GitLab reports against an issue. `closesIssue` is the caller's, not the
 * payload's: GitLab answers the same shape for the ones that merely mention the issue and the
 * ones that close it, and only the endpoint it came from tells them apart.
 *
 * A row is skipped where the merge request does not name its own project, which is the one field
 * of the link that cannot be filled in from anywhere else.
 */
export function decodeLinkedMergeRequestsJson(
  raw: string,
  closesIssue: boolean,
): Result.Result<ReadonlyArray<IssueLinkedPullRequest>, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const links: IssueLinkedPullRequest[] = [];
  for (const entry of decoded.success) {
    const mergeRequest = decodeLinkedMergeRequestEntry(entry);
    if (Exit.isFailure(mergeRequest)) continue;
    const value = mergeRequest.value;
    const repository = trimmed(value.references?.full?.split("!")[0]);
    const title = trimmed(value.title);
    const url = trimmed(value.web_url);
    if (repository === null || title === null || url === null || value.iid <= 0) continue;
    links.push({
      repository,
      number: value.iid,
      title,
      url,
      state: toChangeRequestState(value.state),
      isDraft: value.draft ?? value.work_in_progress ?? false,
      closesIssue,
    });
  }
  return Result.succeed(links);
}

export interface GitLabProjectLabels {
  /** Nothing is marked applied here: which labels the issue has lives on the issue. */
  readonly labels: ReadonlyArray<Omit<IssueLabelCandidate, "isApplied">>;
  readonly rawCount: number;
}

export function decodeProjectLabelsJson(
  raw: string,
): Result.Result<GitLabProjectLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: Array<Omit<IssueLabelCandidate, "isApplied">> = [];
  for (const entry of decoded.success) {
    const label = decodeProjectLabelEntry(entry);
    if (Exit.isFailure(label)) continue;
    const name = trimmed(label.value.name);
    if (name === null) continue;
    labels.push({
      name,
      color: trimmed(label.value.color),
      description: label.value.description ?? null,
    });
  }
  return Result.succeed({ labels, rawCount: decoded.success.length });
}

export interface GitLabProjectMembers {
  /** Nobody is marked assigned here: who the issue has lives on the issue. */
  readonly members: ReadonlyArray<Omit<IssueAssigneeCandidate, "isAssigned">>;
  readonly rawCount: number;
}

/**
 * The people who may be assigned, which `GET /projects/:id/members/all` answers with — including
 * the members a group above the project lends it. The numeric id travels with each of them
 * because that, not the handle, is what GitLab takes when an assignment is written.
 */
export function decodeProjectMembersJson(
  raw: string,
): Result.Result<GitLabProjectMembers, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const members: Array<Omit<IssueAssigneeCandidate, "isAssigned">> = [];
  for (const entry of decoded.success) {
    const user = decodeUserEntry(entry);
    if (Exit.isFailure(user) || user.value.id === undefined) continue;
    const actor = toActor(user.value);
    if (actor === null) continue;
    members.push({ ...actor, id: String(user.value.id) });
  }
  return Result.succeed({ members, rawCount: decoded.success.length });
}
