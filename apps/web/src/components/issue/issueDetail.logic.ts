import type {
  IssueActor,
  IssueComment,
  IssueDetail,
  IssueCapabilities,
  IssueAssigneeCandidate,
  IssueLabel,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueRef,
  IssueState,
  IssueReactionContent,
  IssueReaction,
  PullRequestRef,
} from "@t3tools/contracts";
import { issueEntryKey, prependIssueComments } from "@t3tools/client-runtime/state/issues";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { PULL_REQUEST_REACTION_ORDER } from "../pullRequest/pullRequestReactions.logic";

export function issueStateActionLabel(state: IssueState): string {
  if (state.category === "open" && state.name === "open") return "Reopen";
  if (state.category === "closed" && state.name === "closed") return "Close";
  return state.name;
}

export function sameIssueState(left: IssueState, right: IssueState): boolean {
  return (
    left.category === right.category &&
    (left.id !== undefined && right.id !== undefined
      ? left.id === right.id
      : left.name === right.name)
  );
}

export function retainUnacknowledgedIssueReactions(
  reactions: ReadonlyArray<IssueReaction>,
  desired: ReadonlyMap<IssueReactionContent, boolean>,
): ReadonlyMap<IssueReactionContent, boolean> {
  return new Map(
    [...desired].filter(
      ([content, reacted]) =>
        (reactions.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false) !==
        reacted,
    ),
  );
}

export function issueSupportsReactions(
  capabilities: Pick<IssueCapabilities, "reactions" | "commentReactions">,
  comment: boolean,
): boolean {
  return comment
    ? (capabilities.commentReactions ?? capabilities.reactions)
    : capabilities.reactions;
}

export function offeredIssueReactionContents(
  contents: ReadonlyArray<IssueReactionContent> | undefined,
) {
  return PULL_REQUEST_REACTION_ORDER.filter(
    (content) => contents === undefined || contents.includes(content),
  );
}

export type IssueOlderComments = {
  readonly issue: string;
  readonly seed: string | null;
  readonly firstIds: ReadonlyArray<string>;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly cursor: string | null;
};

export function issueCommentsView(detail: IssueDetail, older: IssueOlderComments | null) {
  const held =
    older?.issue === issueEntryKey(detail) &&
    older.seed === detail.commentsCursor &&
    older.firstIds.length === detail.comments.length &&
    older.firstIds.every((id, index) => id === detail.comments[index]?.id)
      ? older
      : null;
  return {
    comments: prependIssueComments(detail.comments, held?.comments ?? []),
    cursor: held ? held.cursor : detail.commentsCursor,
    held,
  };
}

export function editRetainedIssueComment(
  older: IssueOlderComments | null,
  issue: string,
  id: string,
  body: string,
): IssueOlderComments | null {
  return older === null || older.issue !== issue
    ? older
    : {
        ...older,
        comments: older.comments.map((comment) =>
          comment.id === id ? { ...comment, body } : comment,
        ),
      };
}

export function appendOlderIssueComments(
  detail: IssueDetail,
  older: IssueOlderComments | null,
  page: { readonly comments: ReadonlyArray<IssueComment>; readonly nextCursor: string | null },
): IssueOlderComments {
  return {
    issue: issueEntryKey(detail),
    seed: detail.commentsCursor,
    firstIds: detail.comments.map((comment) => comment.id),
    comments: prependIssueComments(
      issueCommentsView(detail, older).held?.comments ?? [],
      page.comments,
    ),
    cursor: page.nextCursor,
  };
}

export type IssueLinkedPullRequestTarget = Pick<
  PullRequestRef,
  "projectId" | "repository" | "number"
> & {
  host?: string;
  url: string;
};

export const issueAssigneeId = (actor: IssueActor) => actor.id ?? actor.login;

const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function isIssueAssignee(current: ReadonlyArray<IssueActor>, id: string): boolean {
  return current.some((actor) => sameId(issueAssigneeId(actor), id));
}

export function nextIssueAssignees(
  current: ReadonlyArray<IssueActor>,
  candidate: IssueAssigneeCandidate,
  maxAssignees?: number,
): string[] {
  const ids = current.map(issueAssigneeId);
  if (ids.some((id) => sameId(id, candidate.id))) {
    return ids.filter((id) => !sameId(id, candidate.id));
  }
  return maxAssignees === 1 ? [candidate.id] : [...ids, candidate.id];
}

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  fields.some((field) => (field ?? "").toLowerCase().includes(needle));

export function issueLabelId(label: Pick<IssueLabel, "id" | "name">): string {
  return label.id ?? label.name;
}

type IssuePickerKind = "labels" | "assignees";

export type IssuePickerConfirmed = {
  readonly base: IssueDetail;
  readonly environmentId: string;
  readonly kind: IssuePickerKind;
  readonly ids: ReadonlyArray<string>;
};

const nativeIssuePickerIds = (issue: IssueDetail, kind: IssuePickerKind) =>
  kind === "labels" ? issue.labels.map(issueLabelId) : issue.assignees.map(issueAssigneeId);

export function heldIssuePicker(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): IssuePickerConfirmed | null {
  if (
    confirmed === null ||
    confirmed.environmentId !== environmentId ||
    confirmed.kind !== kind ||
    confirmed.base.tracker !== issue.tracker ||
    issueEntryKey(confirmed.base) !== issueEntryKey(issue)
  )
    return null;
  if (confirmed.base === issue) return confirmed;
  const native = nativeIssuePickerIds(issue, kind);
  const wanted = new Set(confirmed.ids.map((id) => (kind === "assignees" ? id.toLowerCase() : id)));
  return native.length === confirmed.ids.length &&
    native.every((id) => wanted.has(kind === "assignees" ? id.toLowerCase() : id))
    ? null
    : confirmed;
}

export function issuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): ReadonlyArray<string> {
  return (
    heldIssuePicker(issue, kind, confirmed, environmentId)?.ids ?? nativeIssuePickerIds(issue, kind)
  );
}

export function issueLabelOptions(
  applied: ReadonlyArray<IssueLabel>,
  fetched: ReadonlyArray<IssueLabelCandidate>,
  query: string,
): IssueLabelCandidate[] {
  const missing = applied
    .filter(
      (label) => !fetched.some((candidate) => issueLabelId(candidate) === issueLabelId(label)),
    )
    .map((label) => ({ ...label, description: null }));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((label) => matches(needle, label.name, label.description));
}

export function issueAssigneeOptions(
  current: ReadonlyArray<IssueActor>,
  fetched: ReadonlyArray<IssueAssigneeCandidate>,
  query: string,
): IssueAssigneeCandidate[] {
  const missing = current
    .map((actor) => ({ ...actor, id: issueAssigneeId(actor) }))
    .filter((actor) => !fetched.some((candidate) => sameId(candidate.id, actor.id)));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((candidate) =>
    matches(needle, candidate.login, candidate.name, candidate.id),
  );
}

export function linkedPullRequestTarget(
  link: IssueLinkedPullRequest,
  reference: IssueRef,
): IssueLinkedPullRequestTarget | null {
  const trackerProvider = sourceControlClients.find(reference.tracker)?.kind;
  const provider = link.provider ?? trackerProvider;
  if (provider === undefined) return null;
  const host = link.host ?? (provider === trackerProvider ? reference.host : undefined);
  return {
    projectId: reference.projectId,
    ...(host === undefined ? {} : { host }),
    repository: link.repository,
    number: link.number,
    url: link.url,
  };
}

export function issueDisplayLabel(scope: string, key: string): string {
  if (key.startsWith("#")) return `${scope}${key}`;
  return /^\d+$/.test(key) ? `${scope}#${key}` : key;
}
