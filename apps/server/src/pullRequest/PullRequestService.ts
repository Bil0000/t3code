import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  pullRequestHostOf,
  pullRequestProviderRequirement,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestCommentInput,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestInvalidateInput,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestProviderSummary,
  type PullRequestRef,
  type PullRequestReviewVerdict,
  type PullRequestSubmitReviewInput,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProviderChangeRequest,
  type PullRequestProviderApi,
  type PullRequestProviderError,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry } from "./PullRequestProviderRegistry.ts";

/**
 * Rows per repository when the client does not ask for a page size. None of the provider tools
 * expose a cursor, so "load more" re-reads a larger page rather than continuing from an offset
 * — cheap at the sizes a change request list reaches, and the tools page internally.
 *
 * 99 and not 100, because every provider asks its host for one row over this to probe for a next
 * page: 99 requests 100, which is exactly what a page of GitHub's API serves — GraphQL refuses
 * `first` over 100 with EXCESSIVE_PAGINATION and REST clamps `per_page` to it — and what GitLab
 * caps `per_page` at. Asking for 100 here would request 101 and buy a whole second round trip for
 * one row (measured: `gh pr list --limit 100` makes 1 HTTP request, `--limit 101` makes 2).
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
/**
 * Repositories read at once. Each one is a CLI process that spends nearly all its wall clock
 * waiting on the host, so the useful ceiling is far above the core count; measured over 12
 * repositories on this listing's own command, 4 took ~12.7s, 8 ~8.9s and 12 ~4.9s, with 16 and 24
 * no faster because 12 already reads every repository in one wave.
 */
const REPOSITORY_CONCURRENCY = 12;

/**
 * Every read leaves the process — a CLI per repository, against hosts whose limits are low
 * (GitHub's search API allows ~30 requests a minute) — so answers are shared for a short
 * while and concurrent identical reads share one request. The windows sit near the clients'
 * own stale times: long enough that two people opening the same page cost one round trip,
 * short enough that "cached" and "fresh" never need telling apart on screen. Reads that
 * must not share — the refresh button, a client reloading after its own action — go through
 * `invalidate` rather than a flag on the read, so an ordinary read can never opt out.
 */
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
const DIFF_CACHE_TTL = Duration.seconds(60);
/** A commit is content-addressed, so its own diff cannot change under its key. */
const COMMIT_DIFF_CACHE_TTL = Duration.minutes(10);
const LIST_CACHE_CAPACITY = 64;
const DETAIL_CACHE_CAPACITY = 128;
const DIFF_CACHE_CAPACITY = 128;

export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;

export class PullRequestService extends Context.Service<
  PullRequestService,
  {
    readonly list: (
      input: PullRequestListInput,
    ) => Effect.Effect<PullRequestListResult, PullRequestError>;
    readonly detail: (input: PullRequestRef) => Effect.Effect<PullRequestDetail, PullRequestError>;
    readonly diff: (
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestError>;
    readonly runAction: (input: PullRequestActionInput) => Effect.Effect<void, PullRequestError>;
    readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestError>;
    readonly submitReview: (
      input: PullRequestSubmitReviewInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly replyToThread: (
      input: PullRequestThreadReplyInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly setThreadResolution: (
      input: PullRequestThreadResolutionInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestService") {}

/** What a verdict is called when refusing it, so the sentence reads as an action. */
const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

/** A project this page can read: its remote is on a host with an implementation. */
interface SupportedProject {
  readonly project: OrchestrationProjectShell;
  readonly api: PullRequestProviderApi;
  readonly repository: string;
  /** The host the repository lives on, which is the account boundary rather than the kind. */
  readonly host: string;
}

/**
 * What the workspace has, split by whether this build can read it. Hosts with no
 * implementation are counted rather than dropped, so their projects are explained in the
 * provider list instead of quietly missing from the page.
 */
interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  /** Keyed by host, as the readable ones are: an unimplemented host is its own switcher entry. */
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  /**
   * Every checkout on a host, including the ones the listing de-duplicated away. Asking who is
   * signed in is a question about the host rather than about a repository, and any checkout can
   * answer it — so a broken worktree is not allowed to take the host down with it just because
   * it happened to be the one the listing kept.
   */
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

interface RepositoryBatch {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
}

/** A host that cannot be read at all, as opposed to one request that failed. */
function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/**
 * Why a host is not readable, told as the thing to do about it. A host that is simply not set up
 * says so in the same words the whole-page state uses, rather than repeating whatever its tool
 * printed — "HTTP 401" names the symptom, not the fix.
 */
function providerDetail(error: PullRequestProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return (
    pullRequestProviderRequirement(
      error.provider,
      error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    ) ?? error.detail
  );
}

function toUnavailableError(error: PullRequestProviderError): PullRequestUnavailableError {
  return new PullRequestUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
    cause: error,
  });
}

function toPullRequestError(
  operation: string,
): (error: PullRequestProviderError) => PullRequestError {
  return (error) =>
    isProviderUnusable(error)
      ? toUnavailableError(error)
      : new PullRequestOperationError({ operation, detail: error.detail, cause: error });
}

/**
 * The provider-native repository identity. `displayName` is the full path below the host, which
 * is what nested GitLab groups and Azure project paths need; owner/name is the two-segment
 * fallback for identities recorded before that field existed.
 */
function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export const make = Effect.gen(function* () {
  const registry = yield* PullRequestProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const listWorkspaceProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "host">,
  ): Effect.Effect<WorkspaceProjects, PullRequestError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) =>
          new PullRequestOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.map((snapshot) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          const kind = project.repositoryIdentity?.provider as
            | SourceControlProviderKind
            | undefined;
          const repository = repositoryIdentityOf(project);
          if (kind === undefined || repository === null) continue;
          // Worktrees of one repository are separate projects; reading the remote once keeps
          // the page from repeating every change request per local checkout. The host is part
          // of the key, so the same `owner/repo` on two hosts stays two repositories.
          const host = pullRequestHostOf(project.repositoryIdentity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
          const api = registry.get(kind);
          // Recorded before the de-duplication below, so the viewer lookup keeps the alternates
          // the listing is about to drop.
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          const key = `${host} ${repository.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (api === null) {
            const counted = unimplemented.get(host);
            if (counted === undefined) unimplemented.set(host, { kind, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({ project, api, repository, host });
        }
        return { supported, unimplemented, viewerRoots };
      }),
    );

  const requireProject = (ref: PullRequestRef): Effect.Effect<SupportedProject, PullRequestError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, PullRequestError> => {
        const match = supported[0];
        if (!match) {
          return Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
        }
        // The repository travels through the client, so it is checked against the project's
        // own remote rather than being handed to a provider verbatim.
        if (match.repository.toLowerCase() !== ref.repository.trim().toLowerCase()) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The change request does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  /**
   * One viewer lookup per host, tried across that host's workspaces so a single broken checkout
   * cannot hide every healthy repository on it. Per host and not per provider kind: two GitHub
   * hosts are two accounts, and the wrong login would misattribute every review request.
   *
   * Its failure doubles as the answer to "is this host set up", which is what the provider
   * switcher shows.
   */
  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
  ) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) => {
        const forHost = projects.filter((project) => project.host === host);
        const api = forHost[0]!.api;
        // Every checkout on the host, not just the ones that survived de-duplication: one
        // unreadable worktree would otherwise report the whole host as signed out.
        const roots = viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
        return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd }))).pipe(
          Effect.map((viewer) => ({
            host,
            kind: api.kind,
            viewer: viewer as string | null,
            error: null as PullRequestProviderError | null,
          })),
          Effect.catch((error) => Effect.succeed({ host, kind: api.kind, viewer: null, error })),
        );
      },
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  const toEntry = (input: {
    readonly project: SupportedProject;
    readonly item: ProviderChangeRequest;
    readonly viewer: string;
  }): PullRequestListEntry => {
    const viewer = input.viewer.toLowerCase();
    return {
      provider: input.project.api.kind,
      host: input.project.host,
      projectId: input.project.project.id,
      projectTitle: input.project.project.title,
      repository: input.project.repository,
      number: input.item.number,
      title: input.item.title,
      url: input.item.url,
      author: input.item.author,
      headBranch: input.item.headBranch,
      baseBranch: input.item.baseBranch,
      state: input.item.state,
      isDraft: input.item.isDraft,
      mergeability: input.item.mergeability,
      additions: input.item.additions,
      deletions: input.item.deletions,
      createdAt: input.item.createdAt,
      updatedAt: input.item.updatedAt,
      viewerReviewRequested:
        input.item.author?.login.toLowerCase() !== viewer &&
        input.item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer),
      labels: input.item.labels,
    };
  };

  const listUncached: PullRequestService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      const {
        supported: projects,
        unimplemented,
        viewerRoots,
      } = yield* listWorkspaceProjects(input);
      const projectCounts = new Map<string, number>();
      for (const { host } of projects) {
        projectCounts.set(host, (projectCounts.get(host) ?? 0) + 1);
      }

      const viewerResults = yield* resolveViewers(projects, viewerRoots);
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer !== null) viewers[result.host] = result.viewer;
      }

      // One summary per host, which is what the viewer lookup already answers for: two GitHub
      // hosts sign in separately, so collapsing them by kind would report one as the other.
      const providers: ReadonlyArray<PullRequestProviderSummary> = [
        ...viewerResults.map((result) => ({
          host: result.host,
          kind: result.kind,
          searchesOnHost:
            projects.find((project) => project.host === result.host)?.api.capabilities.search ??
            false,
          projectCount: projectCounts.get(result.host) ?? 1,
          configured: result.viewer !== null,
          detail: result.error === null ? null : providerDetail(result.error),
        })),
        ...[...unimplemented].map(([host, { kind, projectCount }]) => ({
          host,
          kind,
          searchesOnHost: false,
          projectCount,
          configured: false,
          detail: "This host cannot be browsed here yet.",
        })),
      ];

      const readable = projects.filter(({ host }) => viewers[host] !== undefined);
      // A host that could not be read still has projects, and they are absent from the list.
      // Reporting them keeps "N repositories were unavailable" honest instead of dropping them.
      const unreadable = projects
        .filter(({ host }) => viewers[host] === undefined)
        .map(({ project, repository }) => ({
          projectId: project.id,
          projectTitle: project.title,
          message: `${repository} could not be read.`,
        }));
      if (readable.length === 0) {
        // No host this request covers can be read, so it is not a per-project problem. An
        // unusable host is preferred as the reported cause because it names the fix; a host
        // that merely failed reports as a failed operation rather than as a signed-out CLI,
        // which would send the reader to `auth login` over a transient error.
        const errors = viewerResults.flatMap((result) =>
          result.error === null ? [] : [result.error],
        );
        const blocking = errors.find(isProviderUnusable) ?? errors[0];
        if (blocking) {
          return yield* toPullRequestError("list")(blocking);
        }

        return {
          viewers: viewers as PullRequestListResult["viewers"],
          providers,
          entries: [],
          errors: [],
          truncated: false,
        };
      }

      const batches = yield* Effect.forEach(
        readable,
        (project): Effect.Effect<RepositoryBatch> => {
          const viewer = viewers[project.host]!;
          return project.api
            .listChangeRequests({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              state: input.state,
              involvement,
              viewer,
              limit: input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT,
              // Each host matches this its own way, and one that cannot match text at all
              // answers unnarrowed rather than failing.
              query: input.query,
            })
            .pipe(
              Effect.map(
                (page): RepositoryBatch => ({
                  entries: page.items.map((item) => toEntry({ project, item, viewer })),
                  errors: [],
                  truncated: page.truncated,
                }),
              ),
              // One unreachable repository must not blank the page. A host-level failure is
              // already reported through `providers`, so it degrades the same way here.
              Effect.orElseSucceed(
                (): RepositoryBatch => ({
                  entries: [],
                  errors: [
                    {
                      projectId: project.project.id,
                      projectTitle: project.project.title,
                      message: `${project.repository} could not be read.`,
                    },
                  ],
                  truncated: false,
                }),
              ),
            );
        },
        { concurrency: REPOSITORY_CONCURRENCY },
      );

      return {
        viewers: viewers as PullRequestListResult["viewers"],
        providers,
        entries: batches
          .flatMap((batch) => batch.entries)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        errors: [...unreadable, ...batches.flatMap((batch) => batch.errors)],
        truncated: batches.some((batch) => batch.truncated),
      };
    });

  const detailUncached: PullRequestService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getChangeRequest({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toPullRequestError("detail")),
            Effect.map(
              (changeRequest): PullRequestDetail => ({
                provider: project.api.kind,
                capabilities: project.api.capabilities,
                projectId: project.project.id,
                projectTitle: project.project.title,
                workspaceRoot: project.project.workspaceRoot,
                repository: project.repository,
                number: changeRequest.number,
                title: changeRequest.title,
                body: changeRequest.body,
                url: changeRequest.url,
                author: changeRequest.author,
                state: changeRequest.state,
                isDraft: changeRequest.isDraft,
                mergeability: changeRequest.mergeability,
                additions: changeRequest.additions,
                deletions: changeRequest.deletions,
                changedFiles: changeRequest.changedFiles,
                headBranch: changeRequest.headBranch,
                baseBranch: changeRequest.baseBranch,
                createdAt: changeRequest.createdAt,
                updatedAt: changeRequest.updatedAt,
                mergedAt: changeRequest.mergedAt,
                closedAt: changeRequest.closedAt,
                reviewers: changeRequest.reviewers,
                labels: changeRequest.labels,
                checks: changeRequest.checks,
                comments: changeRequest.comments,
                commentsTruncated: changeRequest.commentsTruncated,
                reviewThreads: changeRequest.reviewThreads,
                commits: changeRequest.commits,
                mergeCapabilities: changeRequest.mergeCapabilities,
              }),
            ),
          ),
      ),
    );

  const diffUncached: PullRequestService["Service"]["diff"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.capabilities.diff
          ? project.api
              .getDiff({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.commit === undefined ? {} : { commit: input.commit }),
              })
              .pipe(Effect.mapError(toPullRequestError("diff")))
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diff",
                detail: "This host cannot provide a diff for a change request.",
              }),
            ),
      ),
    );

  const runAction: PullRequestService["Service"]["runAction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed the action.
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} a change request.`,
            }),
          );
        }
        // A strategy the host does not offer must be refused rather than passed on: every
        // provider maps an unrecognised method to its own default, so asking Azure DevOps to
        // rebase would quietly merge instead of failing.
        if (
          input.mergeMethod !== undefined &&
          !project.api.capabilities.mergeMethods.includes(input.mergeMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot merge with the ${input.mergeMethod} strategy.`,
            }),
          );
        }
        return project.api
          .runAction({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            action: input.action,
            ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
          })
          .pipe(Effect.mapError(toPullRequestError("runAction")));
      }),
    );

  const comment: PullRequestService["Service"]["comment"] = (input) =>
    // The contract keeps the body verbatim because it is markdown, so the "did the user
    // actually write something" check lives here.
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "comment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on a change request.",
            }),
          );
        }
        return project.api
          .comment({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            body: input.body,
          })
          .pipe(Effect.mapError(toPullRequestError("comment")));
      }),
    );

  const submitReview: PullRequestService["Service"]["submitReview"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const review = project.api.capabilities.review;
        const refuse = (detail: string) =>
          Effect.fail(new PullRequestOperationError({ operation: "submitReview", detail }));
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed it.
        if (!review.verdicts.includes(input.verdict)) {
          return refuse(`This host cannot ${VERDICT_LABELS[input.verdict]} a change request.`);
        }
        if (input.comments.length > 0 && !review.inlineComment) {
          return refuse("This host cannot comment on a line of a change request.");
        }
        // A verdict with nothing attached to it is a request every host rejects, and doing so
        // here says which of the two is missing rather than reporting the host's refusal.
        if (
          input.verdict !== "approve" &&
          input.body.trim().length === 0 &&
          input.comments.length === 0
        ) {
          return refuse("A review needs a summary or at least one comment.");
        }
        return project.api
          .submitReview({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          })
          .pipe(Effect.mapError(toPullRequestError("submitReview")));
      }),
    );

  const replyToThread: PullRequestService["Service"]["replyToThread"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "replyToThread",
            detail: "A reply cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.reply) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "replyToThread",
              detail: "This host cannot reply to a review conversation.",
            }),
          );
        }
        return project.api
          .replyToThread({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            threadId: input.threadId,
            body: input.body,
          })
          .pipe(Effect.mapError(toPullRequestError("replyToThread")));
      }),
    );

  const setThreadResolution: PullRequestService["Service"]["setThreadResolution"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.resolve) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setThreadResolution",
              detail: "This host cannot resolve a review conversation.",
            }),
          );
        }
        return project.api
          .setThreadResolution({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            threadId: input.threadId,
            resolved: input.resolved,
          })
          .pipe(Effect.mapError(toPullRequestError("setThreadResolution")));
      }),
    );

  // Epochs are the invalidation mechanism: a key carries its scope's epoch, so bumping the
  // epoch strands every entry made under the old one — no enumerating a cache whose keys
  // (cursors, commits) nothing holds a list of. The counter is shared and monotonic so a
  // scope re-entering `refEpochs` after eviction can never mint a key an old entry still has.
  let epochCounter = 0;
  let listingsEpoch = 0;
  const refEpochs = new Map<string, number>();
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: PullRequestRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  const refEpoch = (ref: PullRequestRef) => refEpochs.get(refScope(ref)) ?? 0;
  const bumpRefEpoch = (ref: PullRequestRef) => {
    const scope = refScope(ref);
    if (!refEpochs.has(scope) && refEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = refEpochs.keys().next().value;
      if (oldest !== undefined) refEpochs.delete(oldest);
    }
    refEpochs.set(scope, ++epochCounter);
  };

  // Keys serialize positionally and parse back in the lookup, so the cache is the only holder
  // of in-flight state: concurrent identical reads coalesce on the key into one host request.
  const listCache = yield* Cache.makeWith(
    (key: string) => {
      // The parse undoes this module's own serialization, so the shapes are known exactly;
      // the cast restores the branded field types JSON cannot carry.
      const [, state, involvement, projectId, host, limit, query] = JSON.parse(key) as [
        number,
        string,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
      ];
      return listUncached({
        state,
        ...(involvement === null ? {} : { involvement }),
        ...(projectId === null ? {} : { projectId }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
      } as PullRequestListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const list: PullRequestService["Service"]["list"] = (input) =>
    Cache.get(
      listCache,
      JSON.stringify([
        listingsEpoch,
        input.state,
        input.involvement ?? null,
        input.projectId ?? null,
        input.host ?? null,
        input.limit ?? null,
        input.query ?? null,
      ]),
    );

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return detailUncached({ projectId, repository, number } as PullRequestRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const detail: PullRequestService["Service"]["detail"] = (input) =>
    Cache.get(
      detailCache,
      JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]),
    );

  const diffCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number, cursor, commit] = JSON.parse(key) as [
        number,
        string,
        string,
        number,
        string | null,
        string | null,
      ];
      return diffUncached({
        projectId,
        repository,
        number,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      } as PullRequestDiffInput);
    },
    {
      capacity: DIFF_CACHE_CAPACITY,
      timeToLive: (exit, key) => {
        if (!Exit.isSuccess(exit)) return Duration.zero;
        const commit = (JSON.parse(key) as ReadonlyArray<unknown>)[5];
        return commit === null ? DIFF_CACHE_TTL : COMMIT_DIFF_CACHE_TTL;
      },
    },
  );
  const diff: PullRequestService["Service"]["diff"] = (input) =>
    Cache.get(
      diffCache,
      JSON.stringify([
        refEpoch(input),
        input.projectId,
        input.repository,
        input.number,
        input.cursor ?? null,
        input.commit ?? null,
      ]),
    );

  const invalidate: PullRequestService["Service"]["invalidate"] = (input) =>
    Effect.sync(() => {
      if (input.reference === undefined) {
        listingsEpoch = ++epochCounter;
        return;
      }
      bumpRefEpoch(input.reference);
    });

  // A mutation's own client re-reads right after it, and every other client's next read must
  // see the action too — so a write forgets the change request it touched and the listings its
  // state change reorders, for everyone, without any client asking.
  const invalidatedByMutation =
    <I extends PullRequestRef>(
      method: (input: I) => Effect.Effect<void, PullRequestError>,
    ): ((input: I) => Effect.Effect<void, PullRequestError>) =>
    (input) =>
      method(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bumpRefEpoch(input);
            listingsEpoch = ++epochCounter;
          }),
        ),
      );

  return PullRequestService.of({
    list,
    detail,
    diff,
    runAction: invalidatedByMutation(runAction),
    comment: invalidatedByMutation(comment),
    submitReview: invalidatedByMutation(submitReview),
    replyToThread: invalidatedByMutation(replyToThread),
    setThreadResolution: invalidatedByMutation(setThreadResolution),
    invalidate,
  });
});

export const layer = Layer.effect(PullRequestService, make);
