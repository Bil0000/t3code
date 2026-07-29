import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestCommentInput,
  type PullRequestDetail,
  type PullRequestDiffResult,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestProviderSummary,
  type PullRequestRef,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestProviderRegistry,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
  type PullRequestProviderError,
} from "./PullRequestProvider.ts";

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
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestError>;
    readonly runAction: (input: PullRequestActionInput) => Effect.Effect<void, PullRequestError>;
    readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestError>;
  }
>()("t3/pullRequest/PullRequestService") {}

/** A project this page can read: its remote is on a host with an implementation. */
interface SupportedProject {
  readonly project: OrchestrationProjectShell;
  readonly api: PullRequestProviderApi;
  readonly repository: string;
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

function toUnavailableError(error: PullRequestProviderError): PullRequestUnavailableError {
  return new PullRequestUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
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

  const listSupportedProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "provider">,
  ): Effect.Effect<ReadonlyArray<SupportedProject>, PullRequestError> =>
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
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          const kind = project.repositoryIdentity?.provider as
            | SourceControlProviderKind
            | undefined;
          const repository = repositoryIdentityOf(project);
          if (kind === undefined || repository === null) continue;
          if (filter.provider !== undefined && kind !== filter.provider) continue;
          const api = registry.get(kind);
          if (api === null) continue;
          // Worktrees of one repository are separate projects; reading the remote once keeps
          // the page from repeating every change request per local checkout.
          const key = `${kind} ${repository.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          supported.push({ project, api, repository });
        }
        return supported;
      }),
    );

  const requireProject = (ref: PullRequestRef): Effect.Effect<SupportedProject, PullRequestError> =>
    listSupportedProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap((projects): Effect.Effect<SupportedProject, PullRequestError> => {
        const match = projects[0];
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
   * cannot hide every healthy repository on it. Its failure doubles as the answer to "is this
   * host set up", which is what the provider switcher shows.
   */
  const resolveViewers = (projects: ReadonlyArray<SupportedProject>) =>
    Effect.forEach(
      [...new Set(projects.map(({ api }) => api.kind))],
      (kind) => {
        const forKind = projects.filter(({ api }) => api.kind === kind);
        const api = forKind[0]!.api;
        return Effect.firstSuccessOf(
          forKind.map(({ project }) => api.getViewer({ cwd: project.workspaceRoot })),
        ).pipe(
          Effect.map((viewer) => ({
            kind,
            viewer: viewer as string | null,
            error: null as PullRequestProviderError | null,
          })),
          Effect.catch((error) => Effect.succeed({ kind, viewer: null, error })),
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
      const projects = yield* listSupportedProjects(input);
      const projectCounts = new Map<SourceControlProviderKind, number>();
      for (const { api } of projects) {
        projectCounts.set(api.kind, (projectCounts.get(api.kind) ?? 0) + 1);
      }

      const viewerResults = yield* resolveViewers(projects);
      const providers: ReadonlyArray<PullRequestProviderSummary> = viewerResults.map((result) => ({
        kind: result.kind,
        projectCount: projectCounts.get(result.kind) ?? 1,
        configured: result.viewer !== null,
        detail: result.error === null ? null : result.error.detail,
      }));
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer !== null) viewers[result.kind] = result.viewer;
      }

      const readable = projects.filter(({ api }) => viewers[api.kind] !== undefined);
      if (readable.length === 0) {
        // Every host this request covers is unusable, so it is not a per-project problem.
        const blocking = viewerResults.find((result) => result.error !== null)?.error;
        if (blocking) {
          return yield* Effect.fail(toUnavailableError(blocking));
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
          const viewer = viewers[project.api.kind]!;
          return project.api
            .listChangeRequests({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
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
        errors: batches.flatMap((batch) => batch.errors),
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
                number: input.number,
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
      Effect.flatMap((project) =>
        project.api
          .runAction({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            number: input.number,
            action: input.action,
            ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
          })
          .pipe(Effect.mapError(toPullRequestError("runAction"))),
      ),
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
      Effect.flatMap((project) =>
        project.api
          .comment({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            number: input.number,
            body: input.body,
          })
          .pipe(Effect.mapError(toPullRequestError("comment"))),
      ),
    );

  return PullRequestService.of({ list, detail, diff, runAction, comment });
});

export const layer = Layer.effect(PullRequestService, make);
