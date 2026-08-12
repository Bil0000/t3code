import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChangeRequestState,
  SourceControlActor,
  SourceControlLabel,
  SourceControlListCursors,
  SourceControlListProjectError,
  SourceControlProviderKind,
} from "./sourceControl.ts";

export const IssueInvolvement = Schema.Literals(["all", "assigned", "authored", "mentioned"]);
export type IssueInvolvement = typeof IssueInvolvement.Type;

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

/** What a listing asks for: either of the two states an issue can be in, or both at once. */
export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

/**
 * Why an issue was closed, which is the difference between work that got done and work that was
 * dropped. Only GitHub records it; elsewhere a closed issue simply has no reason to report.
 */
export const IssueCloseReason = Schema.Literals(["completed", "not-planned"]);
export type IssueCloseReason = typeof IssueCloseReason.Type;

export const IssueAction = Schema.Literals(["close", "reopen"]);
export type IssueAction = typeof IssueAction.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(SourceControlActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type IssueComment = typeof IssueComment.Type;

/**
 * Something that happened to an issue that nobody wrote words for — it was closed, labelled,
 * assigned, renamed. Read alongside the comments so the timeline reads as one history rather than
 * as remarks with the state changes between them missing.
 */
export const IssueEventKind = Schema.Literals([
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "renamed",
  "referenced",
  "milestoned",
  "locked",
  "unlocked",
]);
export type IssueEventKind = typeof IssueEventKind.Type;

export const IssueEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: IssueEventKind,
  actor: Schema.NullOr(SourceControlActor),
  createdAt: IsoDateTime,
  /** What the event was about, where it has a subject: a label name, an assignee, a title. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueEvent = typeof IssueEvent.Type;

/**
 * A change request that says it closes this issue, or mentions it. Carried on the issue so the
 * work an issue produced is one press away from the issue itself, rather than a search on the host.
 */
export const IssueLinkedPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: ChangeRequestState,
  isDraft: Schema.Boolean,
  /** The change request declares that merging it closes this issue, rather than only citing it. */
  closesIssue: Schema.Boolean,
});
export type IssueLinkedPullRequest = typeof IssueLinkedPullRequest.Type;

/**
 * The other direction of the same relationship, carried on a change request. Lives here rather
 * than beside the change request schemas so the two link shapes stay in one file and neither
 * contract has to import the other.
 */
export const IssueLink = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: IssueState,
  closesIssue: Schema.Boolean,
});
export type IssueLink = typeof IssueLink.Type;

/**
 * What a host can do with issues, so a surface hides what is missing rather than offering an
 * action that would fail. Hosts differ widely here: Bitbucket's tracker is switched off per
 * repository, and Azure DevOps has work items instead of issues, with states of its own.
 */
export const IssueCapabilities = Schema.Struct({
  /** A comment can be posted, and the conversation read back. */
  comment: Schema.Boolean,
  /** The state changes this host can carry out; anything absent is never offered. */
  actions: Schema.Array(IssueAction),
  /** Reasons a close can be given. Empty means closing takes no reason. */
  closeReasons: Schema.Array(IssueCloseReason),
  /** A new issue can be filed. */
  create: Schema.Boolean,
  /**
   * The starting points this repository offers for a new issue can be read, so filing begins from
   * what the repository asks for rather than from an empty box.
   */
  issueTemplates: Schema.Boolean,
  /** The title and body of an existing issue can be rewritten. */
  edit: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
  /** The labels a repository has can be listed, so a picker offers them instead of taking text. */
  listLabelCandidates: Schema.Boolean,
  /** The people who may be assigned can be listed, for the same reason. */
  listAssigneeCandidates: Schema.Boolean,
  /** The host can narrow a listing by free text, rather than the page narrowing what arrives. */
  search: Schema.Boolean,
  /** The host reports which change requests reference an issue, so the links are its own. */
  linkedPullRequests: Schema.Boolean,
  /** State changes and labellings are reported, not only comments. */
  timelineEvents: Schema.Boolean,
});
export type IssueCapabilities = typeof IssueCapabilities.Type;

/**
 * What the signed-in account may do with this issue, which is a different question from
 * `capabilities`: that says what the host can do at all, this says whether this viewer may ask
 * for it. A permission the host reports nothing about is granted rather than withheld, so a
 * refusal comes from the host — which says why — rather than from a control that is not there.
 */
export const IssueViewerPermissions = Schema.Struct({
  actions: Schema.Array(IssueAction),
  comment: Schema.Boolean,
  edit: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
  create: Schema.Boolean,
});
export type IssueViewerPermissions = typeof IssueViewerPermissions.Type;

export const IssueListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  /**
   * The host below which `repository` is addressed, so the same provider kind can serve more than
   * one account — github.com and a GitHub Enterprise install are different identities.
   */
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(SourceControlActor),
  state: IssueState,
  stateReason: Schema.NullOr(IssueCloseReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  assignees: Schema.Array(SourceControlActor),
  labels: Schema.Array(SourceControlLabel),
  milestone: Schema.NullOr(TrimmedNonEmptyString),
  commentCount: NonNegativeInt,
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueListCursors = SourceControlListCursors;
export type IssueListCursors = typeof IssueListCursors.Type;

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  involvement: Schema.optional(IssueInvolvement),
  projectId: Schema.optional(ProjectId),
  /**
   * Narrows the listing to one host, named as the host itself rather than as its provider kind.
   * Absent means every host the workspace has.
   */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows to return per repository, which with a continuation is rows per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /**
   * Carry on from an answer already on the page rather than read the listing again. Only the
   * repositories named here are read, one slice each; a repository the page has enough of is
   * left out. Absent asks for the listing from the top.
   */
  cursors: Schema.optional(IssueListCursors),
  /**
   * Free text the hosts themselves are asked to match, rather than a filter over rows that have
   * already arrived: a listing only ever holds a page per repository, so a search that never
   * leaves the client can only find what happened to be loaded. A host with no text filter
   * answers unnarrowed rather than pretending.
   */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type IssueListInput = typeof IssueListInput.Type;

/**
 * A host the workspace has projects on, and whether its issues can be read right now. One per
 * host rather than per provider kind, because signing in is a question about the host.
 */
export const IssueProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  /** False where a search has to be applied to the rows after they arrive. */
  searchesOnHost: Schema.Boolean,
  projectCount: PositiveInt,
  /** False when the provider's CLI or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueProviderSummary = typeof IssueProviderSummary.Type;

export const IssueListProjectError = SourceControlListProjectError;
export type IssueListProjectError = typeof IssueListProjectError.Type;

export const IssueListResult = Schema.Struct({
  /** The signed-in account per host, which is what involvement filtering compares. */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(IssueProviderSummary),
  /** By update, newest first, across every repository this answer covers. */
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(IssueListProjectError),
  /** At least one repository hit the per-repository listing cap. */
  truncated: Schema.Boolean,
  /** Where each repository carries on, to be sent straight back as `cursors`. */
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

/**
 * Forget what the server has cached, so the next read asks the host. With a reference it forgets
 * that one issue; without one it forgets the listings. A separate request rather than a flag on
 * the reads, so an explicit refresh is the only thing that spends host requests.
 */
export const IssueInvalidateInput = Schema.Struct({
  reference: Schema.optional(IssueRef),
});
export type IssueInvalidateInput = typeof IssueInvalidateInput.Type;

export const IssueDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  capabilities: IssueCapabilities,
  /** What this viewer may do, which `capabilities` says nothing about. Both narrow the page. */
  viewerPermissions: IssueViewerPermissions,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(SourceControlActor),
  state: IssueState,
  stateReason: Schema.NullOr(IssueCloseReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  assignees: Schema.Array(SourceControlActor),
  labels: Schema.Array(SourceControlLabel),
  milestone: Schema.NullOr(TrimmedNonEmptyString),
  commentCount: NonNegativeInt,
  linkedPullRequests: Schema.Array(IssueLinkedPullRequest),
});
export type IssueDetail = typeof IssueDetail.Type;

/**
 * The conversation-shaped half of an issue, read independently from the core detail so a long
 * history cannot hold the title, body and actions off screen. `author` is an optional enrichment:
 * a host's conversation query may carry an avatar its basic read does not.
 */
export const IssueActivity = Schema.Struct({
  author: Schema.optional(Schema.NullOr(SourceControlActor)),
  comments: Schema.Array(IssueComment),
  /**
   * How many remarks the host itself counts, which is the number a surface showing a count has to
   * show: `comments` carries what was read. Never less than `comments` holds.
   */
  commentCount: NonNegativeInt,
  /** The read stopped at a bound of its own before the host ran out. */
  commentsTruncated: Schema.Boolean,
  events: Schema.Array(IssueEvent),
});
export type IssueActivity = typeof IssueActivity.Type;

/** The complete detail shape after the independently loaded activity has been applied. */
export const IssueDetailView = Schema.Struct({
  ...IssueDetail.fields,
  ...IssueActivity.fields,
  // A composed view always has the core identity field, even where the activity did not enrich it.
  author: Schema.NullOr(SourceControlActor),
});
export type IssueDetailView = typeof IssueDetailView.Type;

export const IssueActionInput = Schema.Struct({
  ...IssueRef.fields,
  action: IssueAction,
  /** Only sent for a close, and only where the host declared it takes one. */
  reason: Schema.optional(IssueCloseReason),
});
export type IssueActionInput = typeof IssueActionInput.Type;

// Not trimmed: a body is markdown, where leading spaces open a code block and two trailing spaces
// are a line break. The bound keeps oversized payloads off the wire and out of subprocess
// plumbing; the service rejects a body that is only whitespace.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: CommentBody,
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

const IssueTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** A repository with no issue in it, which is what a read about the repository itself takes. */
export const IssueRepositoryRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
});
export type IssueRepositoryRef = typeof IssueRepositoryRef.Type;

export const IssueCreateInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  title: IssueTitle,
  /** May be empty: an issue with a title and nothing else is a legitimate one. */
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
  assignees: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25)),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

export const IssueCreateResult = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type IssueCreateResult = typeof IssueCreateResult.Type;

/**
 * One of the starting points a repository offers for a new issue: a bug report with its own
 * headings, a feature request with the questions it wants answered. Hosts carry different amounts
 * of it — a GitLab template is a body and nothing else — so a field the host has nothing for comes
 * back empty rather than absent, and a chooser can show every host's templates the same way.
 */
export const IssueTemplate = Schema.Struct({
  /** How the host addresses this template, which is what the chooser sends back. */
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** What it is for, shown under the name so the chooser is more than a list of words. */
  about: Schema.String,
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  assignees: Schema.Array(TrimmedNonEmptyString),
});
export type IssueTemplate = typeof IssueTemplate.Type;

/**
 * Somewhere the repository would rather a question went than into its tracker — a forum, a
 * security address, a chat room. Offered beside the templates and opened on the host, because
 * that is where the conversation it points at happens.
 */
export const IssueContactLink = Schema.Struct({
  name: TrimmedNonEmptyString,
  about: Schema.String,
  url: TrimmedNonEmptyString,
});
export type IssueContactLink = typeof IssueContactLink.Type;

export const IssueTemplateList = Schema.Struct({
  templates: Schema.Array(IssueTemplate),
  contactLinks: Schema.Array(IssueContactLink),
  /**
   * Whether an issue may be filed without taking a template. False only where the repository
   * asked for that; one that said nothing allows it, which is every host's own default.
   */
  blankIssuesEnabled: Schema.Boolean,
});
export type IssueTemplateList = typeof IssueTemplateList.Type;

/** Both fields are optional so a rename does not have to resend a body nobody edited. */
export const IssueUpdateInput = Schema.Struct({
  ...IssueRef.fields,
  title: Schema.optional(IssueTitle),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
});
export type IssueUpdateInput = typeof IssueUpdateInput.Type;

/** The whole set, not a change to it: every host writes labels by replacing what is there. */
export const IssueLabelsInput = Schema.Struct({
  ...IssueRef.fields,
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
});
export type IssueLabelsInput = typeof IssueLabelsInput.Type;

export const IssueAssigneesInput = Schema.Struct({
  ...IssueRef.fields,
  /** Who, as the candidate list named them: a host addresses people by its own identifier. */
  assignees: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25)),
});
export type IssueAssigneesInput = typeof IssueAssigneesInput.Type;

export const IssueAssigneeCandidate = Schema.Struct({
  ...SourceControlActor.fields,
  /** How the host addresses this person when an assignment is written, which is not always the
   * handle it shows: GitHub takes a login, GitLab a numeric user id. Opaque to the page. */
  id: TrimmedNonEmptyString,
  isAssigned: Schema.Boolean,
});
export type IssueAssigneeCandidate = typeof IssueAssigneeCandidate.Type;

export const IssueAssigneeCandidateList = Schema.Struct({
  candidates: Schema.Array(IssueAssigneeCandidate),
  /** The host has more people with access than the read asked for; nothing is wrong with the
   * list, it is simply not all of it. */
  truncated: Schema.Boolean,
});
export type IssueAssigneeCandidateList = typeof IssueAssigneeCandidateList.Type;

export const IssueLabelCandidate = Schema.Struct({
  ...SourceControlLabel.fields,
  description: Schema.NullOr(Schema.String),
  isApplied: Schema.Boolean,
});
export type IssueLabelCandidate = typeof IssueLabelCandidate.Type;

export const IssueLabelCandidateList = Schema.Struct({
  candidates: Schema.Array(IssueLabelCandidate),
  truncated: Schema.Boolean,
});
export type IssueLabelCandidateList = typeof IssueLabelCandidateList.Type;

export const IssueUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
  "tracker-disabled",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

/**
 * What each host needs before its issues can be read, so a failure names the fix rather than the
 * symptom. Bitbucket is credentials on the server rather than a signed-in CLI, which is why these
 * are whole sentences instead of a tool name to interpolate.
 */
const PROVIDER_REQUIREMENT: Partial<
  Record<SourceControlProviderKind, { readonly missing: string; readonly unauthenticated: string }>
> = {
  github: {
    missing:
      "GitHub CLI (`gh`) is required to browse issues on this host. Install it from https://cli.github.com/ and reload.",
    unauthenticated: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  },
  gitlab: {
    missing:
      "GitLab CLI (`glab`) is required to browse issues on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
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
 * What a host needs before its issues can be read, as a sentence to show wherever that host is
 * reported as unusable. Null when the reason is not about setting a host up.
 */
export function issueProviderRequirement(
  provider: SourceControlProviderKind,
  reason: IssueUnavailableReason,
): string | null {
  const requirement = PROVIDER_REQUIREMENT[provider];
  if (requirement === undefined) return null;
  switch (reason) {
    case "cli-missing":
      return requirement.missing;
    case "cli-unauthenticated":
      return requirement.unauthenticated;
    case "provider-unsupported":
    case "tracker-disabled":
      return null;
  }
}

/**
 * Issues are switched off for this host or repository. The message is derived from `reason` and
 * the provider rather than from whatever the CLI printed, so it stays a stable sentence the UI
 * can show as-is; the underlying failure travels in `cause`.
 */
export class IssueUnavailableError extends Schema.TaggedErrorClass<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueUnavailableError)(this, { status: 503 });
  }

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
        return "Issues cannot be browsed for this project's host yet.";
      case "tracker-disabled":
        return "This repository has its issue tracker switched off.";
    }
  }
}

export class IssueOperationError extends Schema.TaggedErrorClass<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}
