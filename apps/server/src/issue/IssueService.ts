import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  IssueOperationError,
  IssueUnavailableError,
  issueProviderRequirement,
  sourceControlHostOf,
  type IssueAction,
  type IssueActionInput,
  type IssueActivity,
  type IssueAssigneeCandidateList,
  type IssueAssigneesInput,
  type IssueCommentInput,
  type IssueCreateInput,
  type IssueCreateResult,
  type IssueDetail,
  type IssueInvalidateInput,
  type IssueLabelCandidateList,
  type IssueLabelsInput,
  type IssueListEntry,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueProviderSummary,
  type IssueRef,
  type IssueUpdateInput,
  type OrchestrationProjectShell,
  type SourceControlProviderInfo,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  type IssueProviderApi,
  type IssueProviderError,
  type ProviderIssue,
  type ProviderListCursor,
} from "./IssueProvider.ts";
import { IssueProviderRegistry } from "./IssueProviderRegistry.ts";

/**
 * Rows per repository when the client does not ask for a page size, and rows per slice when a
 * listing is carried on from a cursor. 99 and not 100 because every provider asks its host for one
 * row over this to probe for a next page, and 100 is exactly what GitHub and GitLab serve in one
 * request — so 100 here would buy a whole second round trip for a single row.
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
/**
 * Repositories read at once. Each one is a CLI process that spends nearly all its wall clock
 * waiting on the host, so the useful ceiling is far above the core count.
 */
const REPOSITORY_CONCURRENCY = 12;
/**
 * Repositories named in one read across a host. Well inside what a host's search accepts in one
 * query, and past the size of a workspace anyone opens, so a larger one reads in a handful of
 * searches rather than in a request per repository.
 */
const REPOSITORY_SEARCH_CHUNK = 100;

/**
 * Every read leaves the process — a CLI per repository, against hosts whose limits are low — so
 * answers are shared for a short while and concurrent identical reads share one request. The
 * windows sit near the clients' own stale times: long enough that two people opening the same page
 * cost one round trip, short enough that "cached" and "fresh" never need telling apart on screen.
 * Reads that must not share — the refresh button, a client reloading after its own action — go
 * through `invalidate` rather than a flag on the read, so an ordinary read can never opt out.
 */
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
/**
 * How long a cache's last success may still be served while a fresh read runs behind it. Bounded
 * by how the page actually revalidates: clients re-read on mount and once a minute while open, and
 * every one of those reads repopulates the cache in the background. An explicit refresh or a
 * mutation bumps the epochs and skips held answers entirely.
 */
const LIST_STALE_WINDOW = Duration.minutes(10);
const DETAIL_STALE_WINDOW = Duration.minutes(5);
/** How long one host's signed-in login is believed without asking its CLI again. */
const VIEWER_CACHE_TTL = Duration.minutes(10);
const LIST_CACHE_CAPACITY = 64;
const DETAIL_CACHE_CAPACITY = 128;

export type IssueError = IssueUnavailableError | IssueOperationError;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly activity: (input: IssueRef) => Effect.Effect<IssueActivity, IssueError>;
    readonly runAction: (input: IssueActionInput) => Effect.Effect<void, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly update: (input: IssueUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setLabels: (input: IssueLabelsInput) => Effect.Effect<void, IssueError>;
    readonly setAssignees: (input: IssueAssigneesInput) => Effect.Effect<void, IssueError>;
    readonly labelCandidates: (
      input: IssueRef,
    ) => Effect.Effect<IssueLabelCandidateList, IssueError>;
    readonly assigneeCandidates: (
      input: IssueRef,
    ) => Effect.Effect<IssueAssigneeCandidateList, IssueError>;
    readonly invalidate: (input: IssueInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/issue/IssueService") {}

/**
 * Why a state change is refused to this viewer, said as the access it would take rather than as
 * the refusal the host would have answered with. Both are also the author's to take, whatever
 * access they have.
 */
const ACTION_ACCESS_REFUSALS: Record<IssueAction, string> = {
  close: "You need write access on this repository, or to have opened this issue, to close it.",
  reopen: "You need write access on this repository, or to have opened this issue, to reopen it.",
};

/** Why changing labels is refused, and why the picker behind it is too. */
const LABEL_ACCESS_REFUSAL =
  "You need write access on this repository to change the labels on an issue.";

/** The same, for assignment: the list of people is only ever wanted by somebody about to assign. */
const ASSIGNEE_ACCESS_REFUSAL =
  "You need write access on this repository to change who an issue is assigned to.";

/** A project this page can read: its remote is on a host with an implementation. */
interface SupportedProject {
  readonly project: OrchestrationProjectShell;
  readonly api: IssueProviderApi;
  readonly repository: string;
  /** The host the repository lives on, which is the account boundary rather than the kind. */
  readonly host: string;
}

/**
 * What the workspace has, split by whether this build can read it. Hosts with no implementation
 * are counted rather than dropped, so their projects are explained in the provider list instead of
 * quietly missing from the page.
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
   * answer it — so a broken worktree is not allowed to take the host down with it just because it
   * happened to be the one the listing kept.
   */
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

interface RepositoryBatch {
  /** Which repository this slice came from, which is what a cursor for it is filed under. */
  readonly key: string;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** What the providers are told, plus the part only the service acts on. */
interface ListCursor extends ProviderListCursor {
  /**
   * The rows already handed over at exactly `updatedBefore`. The next read asks for that instant
   * inclusively, so these are what keeps it from sending them a second time.
   */
  readonly seenAt: ReadonlyArray<number>;
}

/**
 * A continuation as it travels through the page and back. Written out rather than encoded because
 * it comes back from a client and has to be believed or refused on sight: everything a host is
 * given is either a timestamp of this shape or a number of this length, which is what lets a
 * provider drop it into a filter without checking it again.
 */
const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?$/;

function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    delivered: Number(match[2]),
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
  };
}

/**
 * How a listing tells two repositories apart. The host is part of it because the same
 * `owner/repo` exists on github.com and on an Enterprise install, and they are two repositories.
 */
function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

/**
 * Where a repository carries on, worked out from the slice just handed over. The boundary is the
 * instant of the oldest row in it: the next read asks for that instant and everything before it,
 * and names the rows already sent at it so none of them arrives twice.
 *
 * The names carry over when the boundary has not moved. A slice that ends on the same instant it
 * began on has to keep the earlier rows excluded as well as its own, or the read after it would
 * hand them over again.
 */
function nextListCursor(
  previous: ListCursor | undefined,
  /** What the host handed over, before the rows already sent were dropped from it. */
  fetched: ReadonlyArray<ProviderIssue>,
  /** What is being sent on, which is what the count of delivered rows is about. */
  delivered: ReadonlyArray<ProviderIssue>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
): string | null {
  // The host had nothing at all, so there is no row to carry on from — and repeating the cursor
  // that produced the empty slice would ask the same question forever.
  if (fetched.length === 0) return null;
  // Taken from what the host answered rather than from what survived de-duplication: a slice can
  // be entirely rows already sent — a hundred issues touched in the same second is one triage
  // afternoon — and reading "nothing new" as "nothing left" would end the walk on the instant it
  // was stuck on, with everything older unreachable for good.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance);
}

/**
 * The same cursor against a boundary chosen elsewhere, which is what a slice read across several
 * repositories at once needs: every repository in it is read up to the oldest row of the whole
 * slice, including the ones that contributed nothing to it — their rows are simply all older, and
 * a repository that carried on from its own oldest row would be right about where it stopped and
 * silent about the ones that never appeared.
 */
function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  /** This repository's own rows in the slice, before the ones already sent were dropped. */
  fetched: ReadonlyArray<ProviderIssue>,
  deliveredCount: number,
): string {
  // De-duplicated because the boundary instant is asked for inclusively: the rows already named
  // here come back with the next slice and would otherwise be named a second time, growing the
  // cursor by one number per round trip until it outgrows what the page may send back.
  const seenAt = [
    ...new Set([
      ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
      ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
    ]),
  ];
  return `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${seenAt.join(",")}`;
}

/**
 * A host that cannot be read at all, as opposed to one request that failed. A switched-off tracker
 * is deliberately not one of these: it is one repository's setting, and reporting it as a dead
 * host would hide every other repository on that account.
 */
function isProviderUnusable(error: IssueProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/**
 * Why a host is not readable, told as the thing to do about it. A host that is simply not set up
 * says so in the same words the whole-page state uses, rather than repeating whatever its tool
 * printed — "HTTP 401" names the symptom, not the fix.
 */
function providerDetail(error: IssueProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return (
    issueProviderRequirement(
      error.provider,
      error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    ) ?? error.detail
  );
}

function toIssueError(operation: string): (error: IssueProviderError) => IssueError {
  return (error) => {
    switch (error.reason) {
      case "missing-tool":
      case "unauthenticated":
        return new IssueUnavailableError({
          reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
          provider: error.provider,
          cause: error,
        });
      // A read of one issue on a repository whose tracker is off has no issue to answer with, and
      // saying so as an unavailability is what lets the page explain the setting rather than
      // report a failure the reader cannot act on.
      case "tracker-disabled":
        return new IssueUnavailableError({
          reason: "tracker-disabled",
          provider: error.provider,
          cause: error,
        });
      case "failed":
        return new IssueOperationError({ operation, detail: error.detail, cause: error });
    }
  };
}

/**
 * The provider-native repository identity. `displayName` is the full path below the host, which is
 * what nested GitLab groups and Azure project paths need; owner/name is the two-segment fallback
 * for identities recorded before that field existed.
 */
function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export const make = Effect.gen(function* () {
  const registry = yield* IssueProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const refineUnknownProjectKinds = (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: Pick<IssueListInput, "projectId" | "host">,
  ) => {
    type RefinementCandidate = {
      readonly project: OrchestrationProjectShell;
      readonly provider: SourceControlProviderInfo;
      readonly remoteName: string;
      readonly remoteUrl: string;
    };
    const refinements = new Map<string, RefinementCandidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (identity?.provider !== "unknown" || repositoryIdentityOf(project) === null) continue;
      const host = sourceControlHostOf(identity, "unknown");
      // A legacy identity has no canonical host until its provider is refined, so it must reach
      // the refinement before a host filter can decide whether it belongs in the result.
      if (filter.host !== undefined && host !== "unknown" && host !== filter.host.toLowerCase()) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
      if (provider !== null) {
        const candidates = refinements.get(provider.baseUrl);
        const candidate = { project, provider, remoteName, remoteUrl };
        if (candidates === undefined) refinements.set(provider.baseUrl, [candidate]);
        else candidates.push(candidate);
      }
    }

    return Effect.forEach(
      refinements,
      ([baseUrl, candidates]) =>
        Effect.firstSuccessOf(
          candidates.map(({ project, provider, remoteName, remoteUrl }) =>
            Effect.suspend(() =>
              sourceControlProviders.resolveHandle({
                cwd: project.workspaceRoot,
                context: { provider, remoteName, remoteUrl },
              }),
            ).pipe(
              Effect.flatMap((handle) => {
                const kind = handle.context?.provider.kind;
                return kind === undefined || kind === "unknown"
                  ? Effect.fail(undefined)
                  : Effect.succeed(kind);
              }),
            ),
          ),
        ).pipe(
          Effect.map((kind) => [baseUrl, kind] as const),
          Effect.orElseSucceed(() => [baseUrl, "unknown"] as const),
        ),
      { concurrency: REPOSITORY_CONCURRENCY },
    ).pipe(Effect.map((resolved) => new Map(resolved)));
  };

  const listWorkspaceProjects = (
    filter: Pick<IssueListInput, "projectId" | "host">,
  ): Effect.Effect<WorkspaceProjects, IssueError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.flatMap((snapshot) =>
        refineUnknownProjectKinds(snapshot.projects, filter).pipe(
          Effect.map((refinedKinds) => ({ refinedKinds, snapshot })),
        ),
      ),
      Effect.map(({ refinedKinds, snapshot }) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          const identity = project.repositoryIdentity;
          let kind = identity?.provider as SourceControlProviderKind | undefined;
          const repository = repositoryIdentityOf(project);
          if (!identity || kind === undefined || repository === null) continue;
          // Worktrees of one repository are separate projects; reading the remote once keeps the
          // page from repeating every issue per local checkout. The host is part of the key, so
          // the same `owner/repo` on two hosts stays two repositories.
          if (kind === "unknown") {
            const provider = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
            kind = provider === null ? kind : (refinedKinds.get(provider.baseUrl) ?? kind);
          }
          const host = sourceControlHostOf(identity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
          const api = registry.get(kind);
          // Recorded before the de-duplication below, so the viewer lookup keeps the alternates
          // the listing is about to drop.
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          const key = listCursorKey(host, repository);
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

  /**
   * The project a request names, with the repository it claims checked against the project's own
   * remote: that field travels through the client, so it is never handed to a provider verbatim.
   */
  const requireProject = (
    ref: Pick<IssueRef, "projectId" | "repository">,
  ): Effect.Effect<SupportedProject, IssueError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, IssueError> => {
        const match = supported[0];
        if (!match) {
          return Effect.fail(new IssueUnavailableError({ reason: "provider-unsupported" }));
        }
        if (match.repository.toLowerCase() !== ref.repository.trim().toLowerCase()) {
          return Effect.fail(
            new IssueOperationError({
              operation: "resolveRepository",
              detail: "The issue does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  /**
   * What the signed-in account may do with this issue, asked of the host itself. Every write goes
   * through it: the page hides what a viewer may not do, and a request that arrived without
   * passing through the page — or after the access behind it was withdrawn — must not be handed to
   * a provider on the client's word. Read freshly for that reason, rather than taken from whatever
   * the detail said when the page loaded.
   */
  const viewerPermissionsOf = (project: SupportedProject, ref: IssueRef, operation: string) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
      })
      .pipe(Effect.mapError(toIssueError(operation)));

  /**
   * The cursors the page sent back, read once before any host is asked anything. Null where the
   * page sent none, which is the listing read from its newest row.
   */
  const decodeCursors = (
    cursors: IssueListInput["cursors"],
  ): Effect.Effect<ReadonlyMap<string, ListCursor> | null, IssueError> => {
    if (cursors === undefined) return Effect.succeed(null);
    const decoded = new Map<string, ListCursor>();
    for (const [key, raw] of Object.entries(cursors)) {
      const cursor = parseListCursor(raw);
      if (cursor === null) {
        return Effect.fail(
          new IssueOperationError({
            operation: "list",
            detail: "The list could not be carried on from where it left off.",
          }),
        );
      }
      decoded.set(key, cursor);
    }
    return Effect.succeed(decoded);
  };

  /**
   * One viewer lookup per host, tried across that host's workspaces so a single broken checkout
   * cannot hide every healthy repository on it. Per host and not per provider kind: two GitHub
   * hosts are two accounts, and the wrong login would misattribute every assignment.
   *
   * Its failure doubles as the answer to "is this host set up", which is what the provider
   * switcher shows.
   */
  type ResolvedViewer = {
    readonly host: string;
    readonly kind: SourceControlProviderKind;
    readonly viewer: string | null;
    readonly error: IssueProviderError | null;
  };
  // Who is signed in moves on the timescale of `gh auth login`, not of a page visit. Only a
  // success is believed for a while: a failure is the "is this host set up" answer the provider
  // switcher shows, and holding it would keep saying signed-out after the reader has signed in.
  const viewersByHost = new Map<string, { readonly at: number; readonly result: ResolvedViewer }>();

  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
  ) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) =>
        Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<ResolvedViewer> => {
          const held = viewersByHost.get(host);
          if (held !== undefined && now - held.at <= Duration.toMillis(VIEWER_CACHE_TTL)) {
            return Effect.succeed(held.result);
          }
          const forHost = projects.filter((project) => project.host === host);
          const api = forHost[0]!.api;
          // Every checkout on the host, not just the ones that survived de-duplication: one
          // unreadable worktree would otherwise report the whole host as signed out.
          const roots =
            viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
          return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd }))).pipe(
            Effect.map((viewer) => ({
              host,
              kind: api.kind,
              viewer: viewer as string | null,
              error: null as IssueProviderError | null,
            })),
            Effect.tap((result) =>
              Effect.map(Clock.currentTimeMillis, (at) => viewersByHost.set(host, { at, result })),
            ),
            Effect.catch((error) => Effect.succeed({ host, kind: api.kind, viewer: null, error })),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  const toEntry = (input: {
    readonly project: SupportedProject;
    readonly item: ProviderIssue;
  }): IssueListEntry => ({
    provider: input.project.api.kind,
    host: input.project.host,
    projectId: input.project.project.id,
    projectTitle: input.project.project.title,
    repository: input.project.repository,
    number: input.item.number,
    title: input.item.title,
    url: input.item.url,
    author: input.item.author,
    state: input.item.state,
    stateReason: input.item.stateReason,
    createdAt: input.item.createdAt,
    updatedAt: input.item.updatedAt,
    closedAt: input.item.closedAt,
    assignees: input.item.assignees,
    labels: input.item.labels,
    milestone: input.item.milestone,
    commentCount: input.item.commentCount,
  });

  /**
   * Why one repository produced no rows. A switched-off tracker is a setting rather than a fault,
   * so it is said as one — the repository is simply not a place issues live.
   */
  const repositoryFailure = (
    project: SupportedProject,
    error: IssueProviderError,
  ): IssueListProjectError => ({
    projectId: project.project.id,
    projectTitle: project.project.title,
    message:
      error.reason === "tracker-disabled"
        ? `Issue tracker is switched off for ${project.repository}.`
        : `${project.repository} could not be read.`,
  });

  const listUncached: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      // Refused whole rather than per repository: a cursor is only ever a value this service
      // issued, so one that does not read as one means the page is sending something it made up,
      // and reading part of the listing under that assumption would quietly lose rows.
      const continuation = yield* decodeCursors(input.cursors);
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
      const providers: ReadonlyArray<IssueProviderSummary> = [
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

      // A continued listing reads only the repositories it was asked to carry on with: every
      // other one is already on the page, and reading it again is the whole cost this is here to
      // avoid. The host summaries above stay over the whole workspace, because the switcher they
      // fill is about the workspace rather than about this slice.
      const selected =
        continuation === null
          ? projects
          : projects.filter(({ host, repository }) =>
              continuation.has(listCursorKey(host, repository)),
            );
      const readable = selected.filter(({ host }) => viewers[host] !== undefined);
      // A host that could not be read still has projects, and they are absent from the list.
      // Reporting them keeps "N repositories were unavailable" honest instead of dropping them.
      const unreadable = selected
        .filter(({ host }) => viewers[host] === undefined)
        .map(({ project, repository }) => ({
          projectId: project.id,
          projectTitle: project.title,
          message: `${repository} could not be read.`,
        }));
      if (readable.length === 0) {
        // No host this request covers can be read, so it is not a per-project problem. An unusable
        // host is preferred as the reported cause because it names the fix; a host that merely
        // failed reports as a failed operation rather than as a signed-out CLI, which would send
        // the reader to `auth login` over a transient error.
        //
        // Only the hosts this request was actually going to read: a continuation that named
        // nothing has asked for nothing, and a host it never mentioned being signed out is no
        // reason to refuse it.
        const errors = viewerResults.flatMap((result) =>
          result.error === null || !selected.some(({ host }) => host === result.host)
            ? []
            : [result.error],
        );
        const blocking = errors.find(isProviderUnusable) ?? errors[0];
        if (blocking) {
          return yield* toIssueError("list")(blocking);
        }

        return {
          viewers: viewers as IssueListResult["viewers"],
          providers,
          entries: [],
          errors: [],
          truncated: false,
          nextCursors: {},
        };
      }

      const limit = input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT;
      const cursorOf = (project: SupportedProject): ListCursor | undefined =>
        continuation?.get(listCursorKey(project.host, project.repository));

      /**
       * One repository asked on its own. What every host without a search across repositories
       * does, and what a batched read falls back to for a repository it could not answer for.
       */
      const readRepository = (project: SupportedProject): Effect.Effect<RepositoryBatch> => {
        const viewer = viewers[project.host]!;
        const key = listCursorKey(project.host, project.repository);
        const cursor = cursorOf(project);
        return project.api
          .listIssues({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            state: input.state,
            involvement,
            viewer,
            limit,
            // Each host matches this its own way, and one that cannot match text at all answers
            // unnarrowed rather than failing.
            query: input.query,
            // Only the two fields a host can act on: which rows have already been sent at the
            // boundary instant is this service's business, not a provider's.
            ...(cursor === undefined
              ? {}
              : { cursor: { updatedBefore: cursor.updatedBefore, delivered: cursor.delivered } }),
          })
          .pipe(
            Effect.map((page): RepositoryBatch => {
              // The boundary instant was asked for inclusively, so the rows already sent at it
              // come back with the slice. Dropping them here rather than asking for strictly
              // older is what keeps their neighbours at the same instant from being skipped.
              const items =
                cursor === undefined
                  ? page.items
                  : page.items.filter(
                      (item) =>
                        item.updatedAt !== cursor.updatedBefore ||
                        !cursor.seenAt.includes(item.number),
                    );
              return {
                key,
                entries: items.map((item) => toEntry({ project, item })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  page.continues && page.truncated
                    ? nextListCursor(cursor, page.items, items, page.cursorAdvance)
                    : null,
              };
            }),
            // One unreadable repository must not blank the page — including the one whose tracker
            // is switched off, which is a host-supported repository that simply has no issues to
            // give rather than a host that cannot be read.
            Effect.catch((error) =>
              Effect.succeed<RepositoryBatch>({
                key,
                entries: [],
                errors: [repositoryFailure(project, error)],
                truncated: false,
                nextCursor: null,
              }),
            ),
          );
      };

      /**
       * One host's repositories in one read. The slice is the newest `limit` rows across all of
       * them, so it is split back up by repository here: the page still reports per project, and
       * each repository still carries on from a cursor of its own.
       *
       * A read that fails is read the long way instead. The batch is an optimisation, and a host
       * that could not answer one question about twelve repositories should not report twelve
       * repositories as unreadable before anyone has asked it about them one at a time.
       */
      const readTogether = (
        chunk: ReadonlyArray<SupportedProject>,
      ): Effect.Effect<ReadonlyArray<RepositoryBatch>> => {
        const first = chunk[0]!;
        const readAcross = first.api.listIssuesAcross;
        const separately = () =>
          Effect.forEach(chunk, readRepository, { concurrency: REPOSITORY_CONCURRENCY });
        if (readAcross === undefined) return separately();
        const viewer = viewers[first.host]!;
        const cursor = cursorOf(first);
        return readAcross({
          cwd: first.project.workspaceRoot,
          host: first.host,
          repositories: chunk.map((project) => project.repository),
          state: input.state,
          involvement,
          viewer,
          limit,
          query: input.query,
          ...(cursor === undefined
            ? {}
            : { cursor: { updatedBefore: cursor.updatedBefore, delivered: cursor.delivered } }),
        }).pipe(
          Effect.flatMap((page) => {
            const rows = new Map<string, Array<ProviderIssue>>();
            for (const item of page.items) {
              const key = item.repository.trim().toLowerCase();
              const held = rows.get(key);
              if (held === undefined) rows.set(key, [item]);
              else held.push(item);
            }
            // The oldest row of the whole slice, which is how far every repository in it has now
            // been read — including the ones that contributed nothing to it.
            const boundary = page.items.reduce<string | null>(
              (oldest, item) =>
                oldest === null || item.updatedAt < oldest ? item.updatedAt : oldest,
              null,
            );
            return Effect.forEach(
              chunk,
              (project): Effect.Effect<RepositoryBatch> => {
                const fetched = rows.get(project.repository.trim().toLowerCase()) ?? [];
                // A host does not index every repository for search — a renamed one answers for
                // its old name with silence rather than with an error, and a switched-off tracker
                // is silent too — so a repository the search said nothing at all about is read on
                // its own, once, before it is believed. Only on its first slice: after that it has
                // a boundary to carry on from, and silence past one means the rows are older
                // rather than absent.
                if (fetched.length === 0 && cursorOf(project) === undefined) {
                  return readRepository(project);
                }
                const cursorHere = cursorOf(project);
                const items =
                  cursorHere === undefined
                    ? fetched
                    : fetched.filter(
                        (item) =>
                          item.updatedAt !== cursorHere.updatedBefore ||
                          !cursorHere.seenAt.includes(item.number),
                      );
                return Effect.succeed({
                  key: listCursorKey(project.host, project.repository),
                  entries: items.map((item) => toEntry({ project, item })),
                  errors: [],
                  truncated: page.truncated,
                  nextCursor:
                    page.truncated && boundary !== null
                      ? listCursorAt(cursorHere, boundary, fetched, items.length)
                      : null,
                });
              },
              { concurrency: REPOSITORY_CONCURRENCY },
            );
          }),
          Effect.catch(separately),
        );
      };

      // A host with a search across repositories is asked once for all of them; everyone else is
      // asked once each. Repositories standing at different points of the same listing are
      // different questions, so they are grouped by the boundary they carry on from.
      const together = new Map<string, Array<SupportedProject>>();
      const separate: Array<SupportedProject> = [];
      for (const project of readable) {
        if (project.api.listIssuesAcross === undefined) {
          separate.push(project);
          continue;
        }
        const key = `${project.host}\n${cursorOf(project)?.updatedBefore ?? ""}`;
        const group = together.get(key);
        if (group === undefined) together.set(key, [project]);
        else group.push(project);
      }
      const reads: Array<Effect.Effect<ReadonlyArray<RepositoryBatch>>> = separate.map((project) =>
        readRepository(project).pipe(Effect.map((batch) => [batch])),
      );
      for (const group of together.values()) {
        for (let start = 0; start < group.length; start += REPOSITORY_SEARCH_CHUNK) {
          reads.push(readTogether(group.slice(start, start + REPOSITORY_SEARCH_CHUNK)));
        }
      }
      const batches = (yield* Effect.all(reads, { concurrency: REPOSITORY_CONCURRENCY })).flat();

      const nextCursors: Record<string, string> = {};
      for (const batch of batches) {
        if (batch.nextCursor !== null) nextCursors[batch.key] = batch.nextCursor;
      }

      return {
        viewers: viewers as IssueListResult["viewers"],
        providers,
        entries: batches
          .flatMap((batch) => batch.entries)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        errors: [...unreadable, ...batches.flatMap((batch) => batch.errors)],
        truncated: batches.some((batch) => batch.truncated),
        nextCursors,
      };
    });

  const detailUncached: IssueService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getIssue({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toIssueError("detail")),
            Effect.map(
              (issue): IssueDetail => ({
                provider: project.api.kind,
                capabilities: project.api.capabilities,
                viewerPermissions: issue.viewerPermissions,
                projectId: project.project.id,
                projectTitle: project.project.title,
                workspaceRoot: project.project.workspaceRoot,
                repository: project.repository,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                url: issue.url,
                author: issue.author,
                state: issue.state,
                stateReason: issue.stateReason,
                createdAt: issue.createdAt,
                updatedAt: issue.updatedAt,
                closedAt: issue.closedAt,
                assignees: issue.assignees,
                labels: issue.labels,
                milestone: issue.milestone,
                commentCount: issue.commentCount,
                linkedPullRequests: issue.linkedPullRequests,
              }),
            ),
          ),
      ),
    );

  const activityUncached: IssueService["Service"]["activity"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getIssueActivity({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toIssueError("activity")),
            Effect.map(
              (activity): IssueActivity => ({
                ...(activity.author === undefined ? {} : { author: activity.author }),
                comments: activity.comments,
                commentCount: activity.commentCount,
                commentsTruncated: activity.commentsTruncated,
                events: activity.events,
              }),
            ),
          ),
      ),
    );

  const runAction: IssueService["Service"]["runAction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed the action.
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new IssueOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} an issue.`,
            }),
          );
        }
        // A reason the host does not record must be refused rather than passed on: a provider
        // that never had one to give would close the issue with no reason at all instead.
        if (
          input.reason !== undefined &&
          !project.api.capabilities.closeReasons.includes(input.reason)
        ) {
          return Effect.fail(
            new IssueOperationError({
              operation: "runAction",
              detail: "This host does not record why an issue was closed.",
            }),
          );
        }
        // What the host can do and what this account may ask of it are two questions, and both
        // have to say yes. The second is asked last, because it costs a request and the checks
        // above do not.
        return viewerPermissionsOf(project, input, "runAction").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.actions.includes(input.action)) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
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
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              })
              .pipe(Effect.mapError(toIssueError("runAction")));
          }),
        );
      }),
    );

  const comment: IssueService["Service"]["comment"] = (input) =>
    // The contract keeps the body verbatim because it is markdown, so the "did the user actually
    // write something" check lives here.
    (input.body.trim().length === 0
      ? Effect.fail(
          new IssueOperationError({ operation: "comment", detail: "A comment cannot be empty." }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new IssueOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "comment",
                  detail: "You need write access on this repository to comment on an issue.",
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
              .pipe(Effect.mapError(toIssueError("comment")));
          }),
        );
      }),
    );

  /**
   * Filing a new issue, which is the one write with no issue to ask permissions about: every
   * host answers "may this account do X" for an issue that exists, and there is none yet. So the
   * host's own capability is the whole gate here, and an account without the access is refused by
   * the host — which says why — rather than by a check that had nothing to read.
   */
  const create: IssueService["Service"]["create"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueCreateResult, IssueError> => {
        if (!project.api.capabilities.create) {
          return Effect.fail(
            new IssueOperationError({
              operation: "create",
              detail: "This host cannot open an issue.",
            }),
          );
        }
        return project.api
          .create({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          })
          .pipe(Effect.mapError(toIssueError("create")));
      }),
    );

  const update: IssueService["Service"]["update"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        const refuse = (detail: string) =>
          Effect.fail(new IssueOperationError({ operation: "update", detail }));
        if (!project.api.capabilities.edit) {
          return refuse("This host cannot rewrite an issue.");
        }
        if (input.title === undefined && input.body === undefined) {
          return refuse("An edit needs a new title or a new body.");
        }
        if (input.title !== undefined && input.title.trim().length === 0) {
          return refuse("A title cannot be empty.");
        }
        // A body is markdown and may legitimately be cleared, so only one written out of spaces
        // is refused — the same "did the user actually write something" check a comment gets.
        if (input.body !== undefined && input.body.length > 0 && input.body.trim().length === 0) {
          return refuse("A body cannot be only whitespace.");
        }
        return viewerPermissionsOf(project, input, "update").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.edit) {
              return refuse(
                "You need write access on this repository, or to have opened this issue, to edit it.",
              );
            }
            return project.api
              .update({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { body: input.body }),
              })
              .pipe(Effect.mapError(toIssueError("update")));
          }),
        );
      }),
    );

  const setLabels: IssueService["Service"]["setLabels"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.api.capabilities.labels) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setLabels",
              detail: "This host cannot label an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setLabels").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.labels) {
              return Effect.fail(
                new IssueOperationError({ operation: "setLabels", detail: LABEL_ACCESS_REFUSAL }),
              );
            }
            return project.api
              .setLabels({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                labels: input.labels,
              })
              .pipe(Effect.mapError(toIssueError("setLabels")));
          }),
        );
      }),
    );

  const setAssignees: IssueService["Service"]["setAssignees"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.api.capabilities.assignees) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setAssignees",
              detail: "This host cannot assign an issue to somebody.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setAssignees").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.assignees) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "setAssignees",
                  detail: ASSIGNEE_ACCESS_REFUSAL,
                }),
              );
            }
            return project.api
              .setAssignees({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                assignees: input.assignees,
              })
              .pipe(Effect.mapError(toIssueError("setAssignees")));
          }),
        );
      }),
    );

  /**
   * What a repository has to offer is only ever wanted by somebody about to apply it, because the
   * picker it fills is the one the change is made from. So the same permission guards both: a page
   * that could open the picker without it would offer a list whose every press was going to be
   * turned down.
   */
  const labelCandidates: IssueService["Service"]["labelCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueLabelCandidateList, IssueError> => {
        if (!project.api.capabilities.listLabelCandidates) {
          return Effect.fail(
            new IssueOperationError({
              operation: "labelCandidates",
              detail: "This host cannot say which labels a repository has.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "labelCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<IssueLabelCandidateList, IssueError> =>
              viewer.labels
                ? project.api
                    .listLabelCandidates({
                      cwd: project.project.workspaceRoot,
                      repository: project.repository,
                      host: project.host,
                      number: input.number,
                    })
                    .pipe(Effect.mapError(toIssueError("labelCandidates")))
                : Effect.fail(
                    new IssueOperationError({
                      operation: "labelCandidates",
                      detail: LABEL_ACCESS_REFUSAL,
                    }),
                  ),
          ),
        );
      }),
    );

  const assigneeCandidates: IssueService["Service"]["assigneeCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueAssigneeCandidateList, IssueError> => {
        if (!project.api.capabilities.listAssigneeCandidates) {
          return Effect.fail(
            new IssueOperationError({
              operation: "assigneeCandidates",
              detail: "This host cannot say who may be assigned an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "assigneeCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<IssueAssigneeCandidateList, IssueError> =>
              viewer.assignees
                ? project.api
                    .listAssigneeCandidates({
                      cwd: project.project.workspaceRoot,
                      repository: project.repository,
                      host: project.host,
                      number: input.number,
                    })
                    .pipe(Effect.mapError(toIssueError("assigneeCandidates")))
                : Effect.fail(
                    new IssueOperationError({
                      operation: "assigneeCandidates",
                      detail: ASSIGNEE_ACCESS_REFUSAL,
                    }),
                  ),
          ),
        );
      }),
    );

  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  /**
   * Stale answers served while a fresh one is fetched behind them. Every read here leaves the
   * process for a CLI whose wall clock is the host's — seconds on a good day, tens of them on a
   * slow network — and the short cache windows above mean almost every page visit pays that clock
   * again. The last success per key is therefore held a while longer: a read inside the window
   * answers with it at once and refreshes the cache in the background, so the next read is fresh
   * without anyone having waited on it.
   *
   * Correctness leans on the epochs: an explicit refresh or a mutation bumps them, the epoch is
   * part of every key, and a held answer under the old key is simply never asked for again.
   */
  const staleWhileRevalidate = <A>(staleFor: Duration.Duration, capacity: number) => {
    const staleMs = Duration.toMillis(staleFor);
    const held = new Map<string, { readonly at: number; readonly value: A }>();
    const record = (key: string, value: A) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (held.size >= capacity) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
      });
    return <E>(key: string, read: Effect.Effect<A, E>): Effect.Effect<A, E> => {
      const recorded = read.pipe(Effect.tap((value) => record(key, value)));
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const snapshot = held.get(key);
        if (snapshot === undefined || now - snapshot.at > staleMs) return recorded;
        // Run as its own fiber rather than a child: the caller is answered and gone before the
        // refresh lands. The read still coalesces on the cache key, so ten stale reads in one
        // window cost one host request — and a failed refresh costs nothing but the retry.
        return Effect.sync(() => runFork(Effect.ignore(recorded))).pipe(Effect.as(snapshot.value));
      });
    };
  };

  // Epochs are the invalidation mechanism: a key carries its scope's epoch, so bumping the epoch
  // strands every entry made under the old one — no enumerating a cache whose keys (cursors)
  // nothing holds a list of. The counter is shared and monotonic so a scope re-entering
  // `refEpochs` after eviction can never mint a key an old entry still has.
  let epochCounter = 0;
  let listingsEpoch = 0;
  const refEpochs = new Map<string, number>();
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: IssueRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  const refEpoch = (ref: IssueRef) => refEpochs.get(refScope(ref)) ?? 0;
  const bumpRefEpoch = (ref: IssueRef) => {
    const scope = refScope(ref);
    if (!refEpochs.has(scope) && refEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = refEpochs.keys().next().value;
      if (oldest !== undefined) refEpochs.delete(oldest);
    }
    refEpochs.set(scope, ++epochCounter);
  };

  // Keys serialize positionally and parse back in the lookup, so the cache is the only holder of
  // in-flight state: concurrent identical reads coalesce on the key into one host request. The
  // continuation cursors are part of the key, entries sorted so one continuation is one key
  // however its record was assembled — a further slice is its own answer, cached like any.
  const listCache = yield* Cache.makeWith(
    (key: string) => {
      // The parse undoes this module's own serialization, so the shapes are known exactly; the
      // cast restores the branded field types JSON cannot carry.
      const [, state, involvement, projectId, host, limit, query, cursorEntries] = JSON.parse(
        key,
      ) as [
        number,
        string,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        ReadonlyArray<[string, string]> | null,
      ];
      return listUncached({
        state,
        ...(involvement === null ? {} : { involvement }),
        ...(projectId === null ? {} : { projectId }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(cursorEntries === null ? {} : { cursors: Object.fromEntries(cursorEntries) }),
      } as IssueListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const staleList = staleWhileRevalidate<IssueListResult>(LIST_STALE_WINDOW, LIST_CACHE_CAPACITY);
  const list: IssueService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      listingsEpoch,
      input.state,
      input.involvement ?? null,
      input.projectId ?? null,
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return staleList(key, Cache.get(listCache, key));
  };

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return detailUncached({ projectId, repository, number } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleDetail = staleWhileRevalidate<IssueDetail>(DETAIL_STALE_WINDOW, DETAIL_CACHE_CAPACITY);
  const detail: IssueService["Service"]["detail"] = (input) => {
    const key = JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]);
    return staleDetail(key, Cache.get(detailCache, key));
  };

  const activityCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return activityUncached({ projectId, repository, number } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleActivity = staleWhileRevalidate<IssueActivity>(
    DETAIL_STALE_WINDOW,
    DETAIL_CACHE_CAPACITY,
  );
  const activity: IssueService["Service"]["activity"] = (input) => {
    const key = JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]);
    return staleActivity(key, Cache.get(activityCache, key));
  };

  const invalidate: IssueService["Service"]["invalidate"] = (input) =>
    Effect.sync(() => {
      if (input.reference === undefined) {
        listingsEpoch = ++epochCounter;
        // A whole-workspace refresh is the reader asking to be re-answered from the hosts, and
        // that includes who the hosts say they are.
        viewersByHost.clear();
        return;
      }
      bumpRefEpoch(input.reference);
    });

  // A mutation's own client re-reads right after it, and every other client's next read must see
  // the change too — so a write forgets the issue it touched and the listings its state change
  // reorders, for everyone, without any client asking.
  const invalidatedByMutation =
    <I extends IssueRef>(
      method: (input: I) => Effect.Effect<void, IssueError>,
    ): ((input: I) => Effect.Effect<void, IssueError>) =>
    (input) =>
      method(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bumpRefEpoch(input);
            listingsEpoch = ++epochCounter;
          }),
        ),
      );

  return IssueService.of({
    list,
    detail,
    activity,
    runAction: invalidatedByMutation(runAction),
    comment: invalidatedByMutation(comment),
    // A new issue belongs on every listing that would hold it, and there is no issue of its own
    // to forget yet.
    create: (input) =>
      create(input).pipe(Effect.tap(() => Effect.sync(() => (listingsEpoch = ++epochCounter)))),
    update: invalidatedByMutation(update),
    setLabels: invalidatedByMutation(setLabels),
    setAssignees: invalidatedByMutation(setAssignees),
    // The candidate lists are deliberately read fresh per menu-open, so they stay uncached.
    labelCandidates,
    assigneeCandidates,
    invalidate,
  });
});

export const layer = Layer.effect(IssueService, make);
