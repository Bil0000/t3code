import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  pullRequestProviderRequirement,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestCommentInput,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
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
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 50;
const REPOSITORY_CONCURRENCY = 4;

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
  readonly unimplemented: ReadonlyMap<SourceControlProviderKind, number>;
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
 * The host below which the repository is addressed. `canonicalKey` is the normalized remote,
 * `host/owner/repo`, so its first segment is the host; the provider kind stands in when there
 * is no canonical key to read, which keeps one bucket per kind as before.
 */
function hostOf(project: OrchestrationProjectShell, kind: SourceControlProviderKind): string {
  const host = project.repositoryIdentity?.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
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
    filter: Pick<PullRequestListInput, "projectId" | "provider">,
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
        const unimplemented = new Map<SourceControlProviderKind, number>();
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          const kind = project.repositoryIdentity?.provider as
            | SourceControlProviderKind
            | undefined;
          const repository = repositoryIdentityOf(project);
          if (kind === undefined || repository === null) continue;
          if (filter.provider !== undefined && kind !== filter.provider) continue;
          // Worktrees of one repository are separate projects; reading the remote once keeps
          // the page from repeating every change request per local checkout. The host is part
          // of the key, so the same `owner/repo` on two hosts stays two repositories.
          const host = hostOf(project, kind);
          const key = `${host} ${repository.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const api = registry.get(kind);
          if (api === null) {
            unimplemented.set(kind, (unimplemented.get(kind) ?? 0) + 1);
            continue;
          }
          supported.push({ project, api, repository, host });
        }
        return { supported, unimplemented };
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
  const resolveViewers = (projects: ReadonlyArray<SupportedProject>) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) => {
        const forHost = projects.filter((project) => project.host === host);
        const api = forHost[0]!.api;
        return Effect.firstSuccessOf(
          forHost.map(({ project }) => api.getViewer({ cwd: project.workspaceRoot })),
        ).pipe(
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

  const list: PullRequestService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      const { supported: projects, unimplemented } = yield* listWorkspaceProjects(input);
      const projectCounts = new Map<SourceControlProviderKind, number>();
      for (const { api } of projects) {
        projectCounts.set(api.kind, (projectCounts.get(api.kind) ?? 0) + 1);
      }

      const viewerResults = yield* resolveViewers(projects);
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer !== null) viewers[result.host] = result.viewer;
      }

      // The switcher filters by provider kind, so several hosts of one kind collapse into one
      // summary: configured when any of them could be read, and detail from one that could not.
      const providers: ReadonlyArray<PullRequestProviderSummary> = [
        ...[...new Set(viewerResults.map((result) => result.kind))].map((kind) => {
          const forKind = viewerResults.filter((result) => result.kind === kind);
          const failing = forKind.flatMap((result) =>
            result.error === null ? [] : [result.error],
          )[0];
          return {
            kind,
            projectCount: projectCounts.get(kind) ?? 1,
            configured: forKind.some((result) => result.viewer !== null),
            detail: failing === undefined ? null : providerDetail(failing),
          };
        }),
        ...[...unimplemented].map(([kind, projectCount]) => ({
          kind,
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

  const detail: PullRequestService["Service"]["detail"] = (input) =>
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

  const diff: PullRequestService["Service"]["diff"] = (input) =>
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

  return PullRequestService.of({
    list,
    detail,
    diff,
    runAction,
    comment,
    submitReview,
    replyToThread,
    setThreadResolution,
  });
});

export const layer = Layer.effect(PullRequestService, make);
