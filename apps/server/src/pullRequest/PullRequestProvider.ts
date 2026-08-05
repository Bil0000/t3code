import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestState,
  PullRequestViewerPermissions,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * The one failure shape every provider reports, so the service can decide what a failure means
 * without knowing which CLI or API produced it.
 *
 * `reason` is the part the service acts on: a missing or unauthenticated tool disables the
 * provider for the whole workspace, while anything else is specific to the request.
 */
export class PullRequestProviderError extends Schema.TaggedErrorClass<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/** A change request as the provider sees it, before the service attaches project context. */
export interface ProviderChangeRequest {
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
  /** Accounts with a review requested. Team-level requests are excluded by each provider. */
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  /** True when the host has more rows than the page size asked for. */
  readonly truncated: boolean;
  /**
   * This page can be carried on from, so the service may hand the caller a cursor for it. False
   * where the host answered in an order a cursor means nothing in, which leaves a larger `limit`
   * as the only way to the rest — what every listing did before there were cursors.
   */
  readonly continues: boolean;
}

/**
 * Where a repository's next slice starts, as the provider that has to ask for it needs it. Built
 * by the service out of the slice it just handed over, so the boundary that decides whether a row
 * arrives twice or not at all is decided in one place rather than in four.
 */
export interface ProviderListCursor {
  /**
   * The instant of the oldest row already handed over, checked against a timestamp's shape before
   * it gets here because it goes into a host's own filter. Asked for inclusively: several rows
   * share one instant often enough — a bot that touches eight change requests writes one timestamp
   * on all eight — and asking for strictly older would lose whichever of them the slice ended
   * before. The service drops the ones it has already sent.
   */
  readonly updatedBefore: string;
  /**
   * How many rows this repository has handed over so far, for a host that carries on by counting
   * rather than by date.
   */
  readonly delivered: number;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  /**
   * The host's own count of the conversation, which a bounded read can fall short of. A host
   * that reports no count of its own answers with what it handed over, which is the same number
   * once the read went to the end.
   */
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  /**
   * What the signed-in account may do with this change request. Read from calls this detail
   * already makes, so knowing it costs nothing extra.
   */
  readonly viewerPermissions: PullRequestViewerPermissions;
}

export interface ProviderDiffSlice {
  readonly patch: string;
  /** Something in this slice could not be shown, as opposed to there being more slices. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo` or `group/subgroup/project`. */
  readonly repository: string;
  /**
   * The host it lives on, which `repository` deliberately leaves out — the same `owner/repo`
   * exists on github.com and on a GitHub Enterprise install, and only the caller knows which
   * one a project's remote points at.
   */
  readonly host: string;
}

/**
 * One host's change requests. Implementations own their own tool and JSON shapes and hand back
 * the neutral types above; anything a host cannot do is declared in `capabilities` rather than
 * failing at call time.
 */
export interface PullRequestProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;

  /** The signed-in account, which is what involvement filtering compares against. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * Free text to narrow the listing by, as the host understands it. A host with no text
       * filter of its own ignores it and answers with the page it would have answered with
       * anyway — the caller narrows what it gets, so an unfiltered page is a wider answer
       * rather than a wrong one.
       */
      readonly query?: string | undefined;
      /**
       * Where to carry on from, rather than reading this repository from its newest row. Absent
       * asks for the first slice, which is every listing that has not been continued.
       */
      readonly cursor?: ProviderListCursor | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  /**
   * The same answer `getChangeRequest` carries, on its own. Asked before anything is written, so
   * a request that reached the server without going past the page is refused by what the host
   * says rather than by what the client claimed — and asked freshly, because access granted or
   * taken away since the page loaded is exactly the case this guards.
   *
   * Implementations read the cheapest thing that answers it, which for a host with nothing to say
   * is no request at all.
   */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestViewerPermissions, PullRequestProviderError>;

  /**
   * One slice of the patch. Only called when `capabilities.diff` is true. A provider that can
   * serve the whole diff at once answers with `nextCursor: null` and is done; one that pages
   * hands back whatever it needs to find the next slice.
   */
  readonly getDiff: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the change request carries. */
      readonly commit?: string | undefined;
    },
  ) => Effect.Effect<ProviderDiffSlice, PullRequestProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Sends a whole review at once. Only called for a verdict the host declared in
   * `capabilities.review.verdicts`, and with line comments only where it declared
   * `inlineComment`.
   */
  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * The people this viewer may ask for a review, with whoever has already been asked marked as
   * such. Only called when `capabilities.reviewers.listCandidates` is true.
   *
   * The author is left out by each provider rather than by the caller, because only the provider
   * knows how the host spells the same person in a candidate list and on a pull request.
   */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  /**
   * Asks for a review, or takes the request back. Only called when
   * `capabilities.reviewers.request` is true.
   *
   * One call for both directions, because that is what every host does with them: GitHub posts and
   * deletes the same collection, and GitLab and Bitbucket write the whole reviewer set either way.
   * Asking again somebody who has already reviewed is a request like any other — which is how a
   * re-request is made.
   */
  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.review.reply` is true. */
  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.review.resolve` is true. */
  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;
}
