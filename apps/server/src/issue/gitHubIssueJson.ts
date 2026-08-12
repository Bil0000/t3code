import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  ChangeRequestState,
  IssueAssigneeCandidate,
  IssueAssigneeCandidateList,
  IssueCloseReason,
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
 * Enum-ish GitHub fields are decoded as plain strings and normalized here: a `gh` release or a
 * GraphQL schema addition that brings a new state reason or timeline event must not fail the whole
 * payload.
 */
const RawActorSchema = Schema.Struct({
  /**
   * Optional because a timeline event can be attributed to nobody — an actor GitHub has since
   * deleted answers as null, and an assignment made by an integration names no login at all.
   */
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only the GraphQL API reports one; `gh issue view --json` has no avatar to give. */
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawMilestoneSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One row as `gh issue list --json` and `gh issue view --json` both spell it. */
const RawIssueSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  /** The empty string on an open issue, which is why this is normalized rather than mapped. */
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  milestone: Schema.optional(Schema.NullOr(RawMilestoneSchema)),
  body: Schema.optional(Schema.String),
});

/**
 * A search's own answer, which is the listing's row one connection deeper: `gh issue list --json`
 * flattens assignees and labels, and GraphQL does not. Everything below the row is optional
 * because a node that is not an issue decodes as an empty object, which is skipped.
 */
const RawSearchItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String }))),
  milestone: Schema.optional(Schema.NullOr(RawMilestoneSchema)),
  comments: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Int }))),
  assignees: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawLabelSchema)))),
      }),
    ),
  ),
});

const RawSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.optional(Schema.NullOr(Schema.Struct({ hasNextPage: Schema.Boolean }))),
      // Row by row, like the listing's own: a node that is not an issue — or one field GitHub
      // changes — is skipped rather than blanking every repository at once.
      nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

/** Where a connection carries on from, which is what the comment walk below follows. */
const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * What GitHub says the viewer may do with an issue. Both are optional so that an install that
 * answers without them still delivers the issue they travel with; an absent permission reads as
 * granted, which is what an unknown one is.
 */
const RawViewerFieldsSchema = Schema.Struct({
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerDidAuthor: Schema.optional(Schema.Boolean),
});

/** A change request as a link to it names it, wherever the reference was found. */
const RawReferenceSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.Int)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  repository: Schema.optional(
    Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/**
 * Every timeline event as one flat shape. GraphQL answers a union whose members carry different
 * fields, so each of them is optional here and `__typename` is what decides which ones were meant.
 */
const RawTimelineItemSchema = Schema.Struct({
  __typename: Schema.String,
  id: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  actor: Schema.optional(Schema.NullOr(RawActorSchema)),
  label: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  assignee: Schema.optional(Schema.NullOr(RawActorSchema)),
  currentTitle: Schema.optional(Schema.NullOr(Schema.String)),
  milestoneTitle: Schema.optional(Schema.NullOr(Schema.String)),
  /** A cross-reference names where it came from; a connection names what was connected. */
  source: Schema.optional(Schema.NullOr(RawReferenceSchema)),
  subject: Schema.optional(Schema.NullOr(RawReferenceSchema)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommentsSchema = Schema.Struct({
  totalCount: Schema.optional(Schema.Int),
  pageInfo: Schema.optional(RawPageInfoSchema),
  nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawCommentSchema)))),
});

const RawIssueSupplementSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      /** Null for a number that names no issue the viewer can see. */
      issue: Schema.NullOr(
        Schema.Struct({
          ...RawViewerFieldsSchema.fields,
          author: Schema.optional(Schema.NullOr(RawActorSchema)),
          assignees: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
              }),
            ),
          ),
          comments: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Int }))),
          closedByPullRequestsReferences: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(
                  Schema.NullOr(Schema.Array(Schema.NullOr(RawReferenceSchema))),
                ),
              }),
            ),
          ),
          timelineItems: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

const RawViewerPermissionsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      issue: Schema.NullOr(RawViewerFieldsSchema),
    }),
  }),
});

const RawActivitySchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.NullOr(
        Schema.Struct({
          author: Schema.optional(Schema.NullOr(RawActorSchema)),
          comments: Schema.optional(Schema.NullOr(RawCommentsSchema)),
          timelineItems: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

const RawCommentPageSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.NullOr(Schema.Struct({ comments: Schema.optional(RawCommentsSchema) })),
    }),
  }),
});

const RawAssigneeCandidatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      assignableUsers: Schema.Struct({
        pageInfo: Schema.optional(RawPageInfoSchema),
        nodes: Schema.Array(Schema.NullOr(RawActorSchema)),
      }),
      issue: Schema.NullOr(
        Schema.Struct({
          assignees: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

/** What `POST /repos/{owner}/{repo}/issues` answers with, which is all a new issue owes back. */
const RawCreatedIssueSchema = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
});

/**
 * `comments` is deliberately absent: `gh issue list --json comments` answers with every remark's
 * whole body rather than with a count, which is megabytes for a page of busy issues. A row from
 * this read reports no conversation size; the search below carries GitHub's own count instead.
 */
export const ISSUE_LIST_JSON_FIELDS =
  "number,title,url,author,state,stateReason,createdAt,updatedAt,closedAt,assignees,labels,milestone";

export const ISSUE_DETAIL_JSON_FIELDS = `${ISSUE_LIST_JSON_FIELDS},body`;

/** GitHub's own ceiling on a connection page, which is what every read below asks for. */
const GRAPHQL_PAGE_SIZE = 100;

/**
 * The ceiling on `search`, which refuses anything larger with EXCESSIVE_PAGINATION — the same
 * bound the pull request search runs into.
 */
export const ISSUE_SEARCH_MAX_ROWS = GRAPHQL_PAGE_SIZE;

/** Timeline events kept per issue, newest last. An issue with more history than this is a bot log,
 *  and the recent end of it is the part anybody reads. */
const TIMELINE_ITEMS = GRAPHQL_PAGE_SIZE;

/**
 * Every repository of a host in one read, which is what makes a listing one request rather than
 * one process per repository.
 *
 * `type: ISSUE` is GitHub's own name for the index pull requests and issues share, so the query
 * itself carries `is:issue` and the node is asked for as an `Issue`: without both, a pull request
 * would arrive on the issues page as an issue.
 *
 * The row count is written into the document rather than sent as a variable because every variable
 * here travels as a string — and it is this module's own number, clamped by the caller, never a
 * reader's.
 *
 * `first` on the two inner connections is a bound rather than a page: an issue with more than
 * twenty labels shows twenty, and one assigned to more than twenty people is past what a row says.
 */
export function issueSearchGraphQlQuery(rows: number): string {
  return `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), ISSUE_SEARCH_MAX_ROWS)}) {
    pageInfo { hasNextPage }
    nodes {
      ... on Issue {
        number
        title
        url
        author { login avatarUrl ... on User { name } }
        state
        stateReason
        createdAt
        updatedAt
        closedAt
        repository { nameWithOwner }
        milestone { title }
        comments { totalCount }
        assignees(first: 20) { nodes { login name avatarUrl } }
        labels(first: 20) { nodes { name color } }
      }
    }
  }
}`;
}

/**
 * Everything about one issue that `gh issue view --json` cannot answer: where the viewer stands,
 * the faces the CLI reports for nobody, the size of the conversation, and the change requests that
 * cite this issue.
 *
 * Links come from two places at once because neither speaks for the other. GitHub records the
 * closing relationship on `closedByPullRequestsReferences`, and it stays there once the change
 * request has merged; `ConnectedEvent` is only written where somebody linked the two by hand, and
 * `DisconnectedEvent` is how that is taken back. Everything else that names the issue is an
 * ordinary cross-reference, which is a mention rather than a promise to close it.
 */
export const ISSUE_SUPPLEMENT_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) {
      viewerCanUpdate
      viewerDidAuthor
      author { login avatarUrl }
      assignees(first: 20) { nodes { login name avatarUrl } }
      comments { totalCount }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true, userLinkedOnly: false) {
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      timelineItems(last: ${TIMELINE_ITEMS}, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT, DISCONNECTED_EVENT]) {
        nodes {
          __typename
          ... on ConnectedEvent {
            subject { __typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } } }
          }
          ... on DisconnectedEvent {
            subject { __typename ... on PullRequest { number repository { nameWithOwner } } }
          }
          ... on CrossReferencedEvent {
            source { __typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/**
 * The viewer's standing, asked on its own. Only the write path needs this: reading an issue
 * already carries the same three fields on a call it was making anyway, and this exists so that a
 * close or an edit is decided by what GitHub says now rather than by what the page was told when
 * it loaded.
 */
export const ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) { viewerCanUpdate viewerDidAuthor }
  }
}`;

/**
 * The conversation and the history in one read. Both come from GraphQL rather than from
 * `gh issue view --json comments`, which reports no avatar for anybody and cannot reach the
 * timeline at all.
 *
 * The events are the newest hundred: an issue with more state changes than that has been machine
 * driven, and the recent end is the part a reader is looking at. The comments are paged from the
 * start instead, which is the order a conversation is read in.
 */
export const ISSUE_ACTIVITY_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      author { login avatarUrl }
      comments(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id author { login avatarUrl } body createdAt url }
      }
      timelineItems(last: ${TIMELINE_ITEMS}, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT, MILESTONED_EVENT, LOCKED_EVENT, UNLOCKED_EVENT]) {
        nodes {
          __typename
          ... on ClosedEvent { id createdAt actor { login avatarUrl } }
          ... on ReopenedEvent { id createdAt actor { login avatarUrl } }
          ... on LabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on UnlabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on AssignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on UnassignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on RenamedTitleEvent { id createdAt actor { login avatarUrl } currentTitle }
          ... on MilestonedEvent { id createdAt actor { login avatarUrl } milestoneTitle }
          ... on LockedEvent { id createdAt actor { login avatarUrl } }
          ... on UnlockedEvent { id createdAt actor { login avatarUrl } }
          ... on CrossReferencedEvent {
            id
            createdAt
            actor { login avatarUrl }
            source { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Issue { number repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/** The rest of a long conversation, without the history the first page already delivered. */
export const ISSUE_COMMENTS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id author { login avatarUrl } body createdAt url }
      }
    }
  }
}`;

/**
 * Who this issue may be assigned to, and who it is already assigned to, in one read.
 *
 * `assignableUsers` is the list GitHub's own picker is built from — everyone with access to the
 * repository — rather than `collaborators`, which the REST API refuses to anyone without push
 * access and which would therefore be empty for exactly the reader most likely to be looking.
 */
export const ASSIGNEE_CANDIDATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: ${GRAPHQL_PAGE_SIZE}) {
      pageInfo { hasNextPage }
      nodes { login name avatarUrl }
    }
    issue(number: $number) { assignees(first: ${GRAPHQL_PAGE_SIZE}) { nodes { login } } }
  }
}`;

/**
 * A GraphQL request as `gh api graphql --input -` takes it. Variables travel in the document
 * rather than as `-f name=value` flags, so a reader's own words never reach argv.
 */
const GraphQlRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.String),
});

const encodeGraphQlRequest = Schema.encodeSync(Schema.fromJsonString(GraphQlRequestSchema));

export function encodeGraphQlRequestJson(input: {
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
}): string {
  return encodeGraphQlRequest({ query: input.query, variables: { ...input.variables } });
}

/**
 * The body of `POST /repos/{owner}/{repo}/issues` and of the `PATCH` that edits one. Every write
 * takes the same road because a title and a body are the reader's own words either way, and the
 * REST API is the only one of GitHub's that accepts both without putting them in argv —
 * `gh issue create --title` and `gh issue edit --title` cannot.
 *
 * Labels and assignees are the whole set rather than a change to it, which is what this endpoint
 * writes: an empty array takes all of them off.
 */
const IssueWriteSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  assignees: Schema.optional(Schema.Array(Schema.String)),
});

const encodeIssueWrite = Schema.encodeSync(Schema.fromJsonString(IssueWriteSchema));

export interface IssueWriteFields {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly assignees?: ReadonlyArray<string> | undefined;
}

export function buildIssueWriteJson(input: IssueWriteFields): string {
  return encodeIssueWrite({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
  });
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: SourceControlActor | null;
  readonly state: IssueState;
  readonly stateReason: IssueCloseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly assignees: ReadonlyArray<SourceControlActor>;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly milestone: string | null;
  readonly commentCount: number;
}

export interface GitHubIssueDetail extends GitHubIssue {
  readonly body: string;
}

export interface GitHubIssueSearchItem extends GitHubIssue {
  /** `owner/name` as GitHub spells it, which is how a row from a search finds its repository. */
  readonly repository: string;
}

/** Everything one GraphQL read adds to the issue `gh issue view --json` already answered with. */
export interface GitHubIssueSupplement {
  readonly viewer: GitHubIssueViewerAccess;
  /** Avatars by login, for the actors `gh issue view --json` reports without one — which is all
   *  of them, since no `gh` JSON field carries an avatar. */
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  readonly commentCount: number;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/**
 * Everything GitHub says about what the signed-in account may do here. `canTriage` is about the
 * repository, the other two about this issue in particular — which is why the author of an issue
 * can still be told apart from a passer-by.
 */
export interface GitHubIssueViewerAccess {
  /** A role that can label, assign and milestone. Triage exists for exactly that. */
  readonly canTriage: boolean;
  /** GitHub's own `viewerCanUpdate`, true for the author as well as for anyone with write. */
  readonly canUpdate: boolean;
  readonly didAuthor: boolean;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Null once a connection has nothing further, which is what ends the comment walk. GitHub sends an
 * `endCursor` on a page that is also the last one, so the flag is what decides, not the cursor.
 */
function nextCursorOf(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): string | null {
  return pageInfo?.hasNextPage === true ? trimmed(pageInfo.endCursor) : null;
}

function toActor(
  raw: Schema.Schema.Type<typeof RawActorSchema> | null | undefined,
): SourceControlActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toActors(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawActorSchema> | null> | null | undefined,
): ReadonlyArray<SourceControlActor> {
  return (raw ?? []).flatMap((entry) => {
    const actor = toActor(entry);
    return actor === null ? [] : [actor];
  });
}

function toLabels(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawLabelSchema> | null> | null | undefined,
): ReadonlyArray<SourceControlLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label?.name);
    return name === null ? [] : [{ name, color: trimmed(label?.color) }];
  });
}

/** GitHub answers the empty string for an open issue and `REOPENED` for one opened again, and
 *  neither is a reason a closed issue was closed for. */
function toStateReason(value: string | null | undefined): IssueCloseReason | null {
  switch (value?.trim().toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not-planned";
    default:
      return null;
  }
}

function toState(value: string | null | undefined): IssueState {
  return value?.trim().toUpperCase() === "CLOSED" ? "closed" : "open";
}

/**
 * The viewer's standing on one issue. The halves take opposite defaults on purpose.
 *
 * Updating is a permission, so an install that does not report it grants it and lets the host's own
 * refusal explain anything that fails. Authorship is not a permission but a fact about who wrote
 * the thing, so an unknown answer is "not the author", which grants nothing it should not. A role
 * the host named nothing for is no role, because labelling somebody else's issue is not something
 * to offer a reader who cannot do it.
 */
function toViewerAccess(raw: {
  readonly viewerPermission?: string | null | undefined;
  readonly issue: Schema.Schema.Type<typeof RawViewerFieldsSchema> | null;
}): GitHubIssueViewerAccess {
  switch (raw.viewerPermission?.trim().toUpperCase()) {
    case "ADMIN":
    case "MAINTAIN":
    case "WRITE":
    case "TRIAGE":
      return {
        canTriage: true,
        canUpdate: raw.issue?.viewerCanUpdate !== false,
        didAuthor: raw.issue?.viewerDidAuthor === true,
      };
    default:
      return {
        canTriage: false,
        canUpdate: raw.issue?.viewerCanUpdate !== false,
        didAuthor: raw.issue?.viewerDidAuthor === true,
      };
  }
}

function toChangeRequestState(value: string | null | undefined): ChangeRequestState {
  switch (value?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

/** Where a reference is filed, which is what makes two sightings of one change request one link. */
function referenceKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

/**
 * A change request as a link to it, or null for a reference to anything else — an issue that cites
 * this one is a mention between issues rather than the work that answers it.
 */
function toLinkedPullRequest(
  raw: Schema.Schema.Type<typeof RawReferenceSchema> | null | undefined,
  closesIssue: boolean,
): IssueLinkedPullRequest | null {
  if (raw == null) return null;
  // Absent on `closedByPullRequestsReferences`, whose nodes are pull requests by definition.
  const typename = trimmed(raw.__typename);
  if (typename !== null && typename !== "PullRequest") return null;
  const repository = trimmed(raw.repository?.nameWithOwner);
  const title = trimmed(raw.title);
  const url = trimmed(raw.url);
  const number = raw.number ?? 0;
  if (repository === null || title === null || url === null || number <= 0) return null;
  return {
    repository,
    number,
    title,
    url,
    state: toChangeRequestState(raw.state),
    isDraft: raw.isDraft ?? false,
    closesIssue,
  };
}

/**
 * The change GitHub recorded, or null for an event kind this page has no vocabulary for. Anything
 * unmapped is dropped rather than guessed at — a timeline missing an entry is better than one
 * asserting the wrong thing happened.
 */
function toEventFields(
  raw: Schema.Schema.Type<typeof RawTimelineItemSchema>,
): { readonly kind: IssueEventKind; readonly detail: string | null } | null {
  switch (raw.__typename) {
    case "ClosedEvent":
      return { kind: "closed", detail: null };
    case "ReopenedEvent":
      return { kind: "reopened", detail: null };
    case "LabeledEvent":
      return { kind: "labeled", detail: trimmed(raw.label?.name) };
    case "UnlabeledEvent":
      return { kind: "unlabeled", detail: trimmed(raw.label?.name) };
    case "AssignedEvent":
      return { kind: "assigned", detail: trimmed(raw.assignee?.login) };
    case "UnassignedEvent":
      return { kind: "unassigned", detail: trimmed(raw.assignee?.login) };
    case "RenamedTitleEvent":
      return { kind: "renamed", detail: trimmed(raw.currentTitle) };
    case "MilestonedEvent":
      return { kind: "milestoned", detail: trimmed(raw.milestoneTitle) };
    case "LockedEvent":
      return { kind: "locked", detail: null };
    case "UnlockedEvent":
      return { kind: "unlocked", detail: null };
    case "CrossReferencedEvent": {
      const repository = trimmed(raw.source?.repository?.nameWithOwner);
      const number = raw.source?.number ?? 0;
      return {
        kind: "referenced",
        detail: repository === null || number <= 0 ? null : `${repository}#${number}`,
      };
    }
    default:
      return null;
  }
}

function toIssue(raw: Schema.Schema.Type<typeof RawIssueSchema>): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    state: toState(raw.state),
    stateReason: toStateReason(raw.stateReason),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: trimmed(raw.closedAt),
    assignees: toActors(raw.assignees),
    labels: toLabels(raw.labels),
    milestone: trimmed(raw.milestone?.title),
    // The listing has no count that is not the whole conversation; the search below has one.
    commentCount: 0,
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeSearch = decodeJsonResult(RawSearchSchema);
const decodeSearchItem = Schema.decodeUnknownExit(RawSearchItemSchema);
const decodeTimelineItem = Schema.decodeUnknownExit(RawTimelineItemSchema);
const decodeSupplement = decodeJsonResult(RawIssueSupplementSchema);
const decodeViewerPermissions = decodeJsonResult(RawViewerPermissionsSchema);
const decodeActivity = decodeJsonResult(RawActivitySchema);
const decodeCommentPage = decodeJsonResult(RawCommentPageSchema);
const decodeAssigneeCandidates = decodeJsonResult(RawAssigneeCandidatesSchema);
const decodeLabelEntry = Schema.decodeUnknownExit(RawLabelSchema);
const decodeCreatedIssue = decodeJsonResult(RawCreatedIssueSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitHubIssueListBatch {
  readonly items: ReadonlyArray<GitHubIssue>;
  /** Rows gh returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected issue must not
 *  blank the whole list. */
export function decodeIssueListJson(
  raw: string,
): Result.Result<GitHubIssueListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitHubIssue[] = [];
  for (const entry of decoded.success) {
    const item = decodeIssueEntry(entry);
    if (Exit.isSuccess(item)) items.push(toIssue(item.value));
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitHubIssueDetail, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ ...toIssue(decoded.success), body: decoded.success.body ?? "" })
    : Result.fail(decoded.failure);
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  const decoded = decodeCreatedIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ number: decoded.success.number, url: decoded.success.html_url })
    : Result.fail(decoded.failure);
}

export interface GitHubIssueSearchBatch {
  /** Rows across every repository asked for, newest update first, each naming its own. */
  readonly items: ReadonlyArray<GitHubIssueSearchItem>;
  /** Rows the search returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
  /** More rows than this slice asked for, which is truncation for every repository in it. */
  readonly hasNextPage: boolean;
}

/**
 * A search answers with the same issue the listing does, one connection deeper: assignees and
 * labels arrive as connections, the row names the repository it came from, and GitHub's own count
 * of the conversation comes with it. Flattened to the shape `gh issue list --json` hands over so
 * both reads decode into one type.
 *
 * Rows that are not issues decode as empty and are skipped, the way a malformed listing row is —
 * `is:issue` and the `... on Issue` fragment already exclude them, and one surprise must not blank
 * a whole host.
 */
export function decodeIssueSearchJson(
  raw: string,
): Result.Result<GitHubIssueSearchBatch, DecodeFailure> {
  const decoded = decodeSearch(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const nodes = decoded.success.data.search.nodes ?? [];
  const items: GitHubIssueSearchItem[] = [];
  for (const entry of nodes) {
    const decodedNode = decodeSearchItem(entry);
    if (!Exit.isSuccess(decodedNode)) continue;
    const node = decodedNode.value;
    const repository = trimmed(node.repository?.nameWithOwner);
    if (repository === null) continue;
    items.push({
      ...toIssue({
        ...node,
        assignees: toActors(node.assignees?.nodes),
        labels: (node.labels?.nodes ?? []).flatMap((label) => (label === null ? [] : [label])),
      }),
      commentCount: Math.max(0, node.comments?.totalCount ?? 0),
      repository,
    });
  }
  return Result.succeed({
    items,
    rawCount: nodes.length,
    hasNextPage: decoded.success.data.search.pageInfo?.hasNextPage ?? false,
  });
}

export function decodeIssueSupplementJson(
  raw: string,
): Result.Result<GitHubIssueSupplement, DecodeFailure> {
  const decoded = decodeSupplement(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const issue = repository.issue;
  const avatarsByLogin = new Map<string, string>();
  for (const actor of [issue?.author, ...(issue?.assignees?.nodes ?? [])]) {
    const login = trimmed(actor?.login);
    const avatarUrl = trimmed(actor?.avatarUrl);
    if (login !== null && avatarUrl !== null) avatarsByLogin.set(login, avatarUrl);
  }

  // Whoever GitHub says closes the issue leads, then the hand-made connections still standing,
  // then the mentions — so a change request seen twice is filed under the stronger relationship.
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const node of issue?.closedByPullRequestsReferences?.nodes ?? []) {
    const link = toLinkedPullRequest(node, true);
    if (link !== null) links.set(referenceKey(link.repository, link.number), link);
  }
  const connected = new Map<string, IssueLinkedPullRequest>();
  const mentions = new Map<string, IssueLinkedPullRequest>();
  for (const entry of issue?.timelineItems?.nodes ?? []) {
    const decodedItem = decodeTimelineItem(entry);
    if (!Exit.isSuccess(decodedItem)) continue;
    const item = decodedItem.value;
    if (item.__typename === "ConnectedEvent") {
      const link = toLinkedPullRequest(item.subject, true);
      if (link !== null) connected.set(referenceKey(link.repository, link.number), link);
      continue;
    }
    // In timeline order, so a link made, dropped and made again ends up as it stands today.
    if (item.__typename === "DisconnectedEvent") {
      const repository = trimmed(item.subject?.repository?.nameWithOwner);
      const number = item.subject?.number ?? 0;
      if (repository !== null && number > 0) connected.delete(referenceKey(repository, number));
      continue;
    }
    const link = toLinkedPullRequest(item.source, false);
    if (link !== null) mentions.set(referenceKey(link.repository, link.number), link);
  }
  for (const [key, link] of [...connected, ...mentions]) {
    if (!links.has(key)) links.set(key, link);
  }

  return Result.succeed({
    viewer: toViewerAccess(repository),
    avatarsByLogin,
    commentCount: Math.max(0, issue?.comments?.totalCount ?? 0),
    linkedPullRequests: [...links.values()],
  });
}

export function decodeIssueViewerPermissionsJson(
  raw: string,
): Result.Result<GitHubIssueViewerAccess, DecodeFailure> {
  const decoded = decodeViewerPermissions(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toViewerAccess(decoded.success.data.repository))
    : Result.fail(decoded.failure);
}

export interface GitHubIssueActivityPage {
  /** Richer than the listing's author: this read carries the avatar no `gh` JSON field does. */
  readonly author: SourceControlActor | null;
  readonly comments: ReadonlyArray<IssueComment>;
  /** GitHub's own count of the conversation, which a bounded read can fall short of. */
  readonly commentCount: number;
  /** Where the rest of the conversation carries on from, or null once it is whole. */
  readonly nextCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
}

function toComments(
  raw: Schema.Schema.Type<typeof RawCommentsSchema> | null | undefined,
): ReadonlyArray<IssueComment> {
  return (raw?.nodes ?? []).flatMap((comment) => {
    const id = trimmed(comment?.id);
    if (comment == null || id === null) return [];
    return [
      {
        id,
        author: toActor(comment.author),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        url: trimmed(comment.url),
      },
    ];
  });
}

/** One page of the conversation, with the history the first page carries alongside it. */
export function decodeIssueActivityJson(
  raw: string,
): Result.Result<GitHubIssueActivityPage, DecodeFailure> {
  const decoded = decodeActivity(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const issue = decoded.success.data.repository.issue;
  const events: IssueEvent[] = [];
  for (const entry of issue?.timelineItems?.nodes ?? []) {
    const decodedItem = decodeTimelineItem(entry);
    if (!Exit.isSuccess(decodedItem)) continue;
    const item = decodedItem.value;
    const fields = toEventFields(item);
    const id = trimmed(item.id);
    const createdAt = trimmed(item.createdAt);
    if (fields === null || id === null || createdAt === null) continue;
    events.push({
      id,
      kind: fields.kind,
      actor: toActor(item.actor),
      createdAt,
      detail: fields.detail,
    });
  }
  return Result.succeed({
    author: toActor(issue?.author),
    comments: toComments(issue?.comments),
    commentCount: Math.max(0, issue?.comments?.totalCount ?? 0),
    nextCursor: nextCursorOf(issue?.comments?.pageInfo),
    events,
  });
}

/** The rest of one conversation, in the shape the first page already delivered it. */
export function decodeIssueCommentsJson(raw: string): Result.Result<
  {
    readonly comments: ReadonlyArray<IssueComment>;
    readonly nextCursor: string | null;
  },
  DecodeFailure
> {
  const decoded = decodeCommentPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments = decoded.success.data.repository.issue?.comments;
  return Result.succeed({
    comments: toComments(comments),
    nextCursor: nextCursorOf(comments?.pageInfo),
  });
}

export interface GitHubRepositoryLabels {
  /** Nothing is marked applied here: which labels the issue has lives on the issue. */
  readonly labels: ReadonlyArray<Omit<IssueLabelCandidate, "isApplied">>;
  readonly rawCount: number;
}

export function decodeRepositoryLabelsJson(
  raw: string,
): Result.Result<GitHubRepositoryLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: Array<Omit<IssueLabelCandidate, "isApplied">> = [];
  for (const entry of decoded.success) {
    const label = decodeLabelEntry(entry);
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

/**
 * The people this issue may be assigned to, with whoever already has it marked. Anyone assigned
 * leads the list even where GitHub no longer counts them assignable — somebody whose access was
 * taken away is still assigned, and an assignment that cannot be seen cannot be taken back.
 */
export function decodeAssigneeCandidatesJson(
  raw: string,
): Result.Result<IssueAssigneeCandidateList, DecodeFailure> {
  const decoded = decodeAssigneeCandidates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const candidates = new Map<string, IssueAssigneeCandidate>();
  for (const node of repository.issue?.assignees?.nodes ?? []) {
    const actor = toActor(node);
    // GitHub addresses an assignee by the same login it shows, so the id is the handle itself.
    if (actor !== null)
      candidates.set(actor.login, { ...actor, id: actor.login, isAssigned: true });
  }
  for (const node of repository.assignableUsers.nodes) {
    const actor = toActor(node);
    if (actor === null || candidates.has(actor.login)) continue;
    candidates.set(actor.login, { ...actor, id: actor.login, isAssigned: false });
  }
  return Result.succeed({
    candidates: [...candidates.values()],
    truncated: repository.assignableUsers.pageInfo?.hasNextPage === true,
  });
}
