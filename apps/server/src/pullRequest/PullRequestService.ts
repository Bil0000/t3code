import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestActionInput,
  type PullRequestCommentInput,
  type PullRequestDetail,
  type PullRequestDiffResult,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestRef,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import type { GitHubPullRequestListItem } from "./gitHubPullRequestJson.ts";

/**
 * Rows per repository when the client does not ask for a page size. `gh pr list` has no
 * cursor, so "load more" re-reads a larger page rather than continuing from an offset —
 * cheap at the sizes a pull request list reaches, and the CLI pages internally.
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 50;
const REPOSITORY_LIST_CONCURRENCY = 4;
/** `gh pr view --json comments` returns one page; a full page means more exist on GitHub. */
const CONVERSATION_PAGE_SIZE = 100;

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

interface GitHubProject {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
}

interface RepositoryBatch {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
}

/** `gh` being absent or logged out disables the whole feature, so it is reported as such
 *  instead of being folded into a single project's error list. */
function unavailableReason(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestUnavailableError["reason"] | null {
  if (error._tag === "GitHubCliUnavailableError") return "cli-missing";
  if (error._tag === "GitHubCliAuthenticationError") return "cli-unauthenticated";
  return null;
}

/** Either way the CLI failure travels in `cause`; only the reported shape differs. */
function toPullRequestError(
  operation: string,
): (error: GitHubPullRequestCli.GitHubPullRequestCliError) => PullRequestError {
  return (error) => {
    const reason = unavailableReason(error);
    return reason === null
      ? new PullRequestOperationError({ operation, detail: error.detail, cause: error })
      : new PullRequestUnavailableError({ reason, cause: error });
  };
}

function gitHubProjectsFrom(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  projectId: ProjectId | undefined,
): ReadonlyArray<GitHubProject> {
  const seenRepositories = new Set<string>();
  const gitHubProjects: GitHubProject[] = [];
  for (const project of projects) {
    if (projectId !== undefined && project.id !== projectId) continue;
    const identity = project.repositoryIdentity;
    if (!identity || identity.provider !== "github" || !identity.owner || !identity.name) continue;
    const repository = `${identity.owner}/${identity.name}`;
    // Worktrees of the same repository are separate projects; listing the remote once keeps
    // the page from repeating every pull request per local checkout.
    if (seenRepositories.has(repository.toLowerCase())) continue;
    seenRepositories.add(repository.toLowerCase());
    gitHubProjects.push({ project, repository });
  }
  return gitHubProjects;
}

function toListEntry(input: {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
  readonly item: GitHubPullRequestListItem;
  readonly viewer: string;
}): PullRequestListEntry {
  const viewer = input.viewer.toLowerCase();
  return {
    projectId: input.project.id,
    projectTitle: input.project.title,
    repository: input.repository,
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
}

export const make = Effect.gen(function* () {
  const github = yield* GitHubPullRequestCli.GitHubPullRequestCli;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const listGitHubProjects = (
    projectId: ProjectId | undefined,
  ): Effect.Effect<ReadonlyArray<GitHubProject>, PullRequestError> =>
    projections.getShellSnapshot().pipe(
      Effect.map((snapshot) => gitHubProjectsFrom(snapshot.projects, projectId)),
      Effect.mapError(
        (error) =>
          new PullRequestOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
    );

  const requireGitHubProject = (
    ref: PullRequestRef,
  ): Effect.Effect<GitHubProject, PullRequestError> =>
    listGitHubProjects(ref.projectId).pipe(
      Effect.flatMap((projects): Effect.Effect<GitHubProject, PullRequestError> => {
        const match = projects[0];
        if (!match) {
          return Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
        }
        // The repository travels through the client, so it is checked against the project's
        // own remote rather than being passed to `gh --repo` verbatim.
        if (match.repository.toLowerCase() !== ref.repository.trim().toLowerCase()) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The pull request does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  const list: PullRequestService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      const projects = yield* listGitHubProjects(input.projectId);
      if (projects.length === 0) {
        return { viewer: null, entries: [], errors: [], truncated: false };
      }

      // Any GitHub-backed workspace can answer who the viewer is, so a broken first checkout
      // falls through to the next one rather than blanking every healthy repository.
      const viewer = yield* Effect.firstSuccessOf(
        projects.map(({ project }) => github.getViewerLogin({ cwd: project.workspaceRoot })),
      ).pipe(Effect.mapError(toPullRequestError("viewer")));

      const batches = yield* Effect.forEach(
        projects,
        ({ project, repository }): Effect.Effect<RepositoryBatch, PullRequestError> =>
          github
            .listPullRequests({
              cwd: project.workspaceRoot,
              repository,
              state: input.state,
              involvement,
              viewer,
              limit: input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT,
            })
            .pipe(
              Effect.map(
                (batch): RepositoryBatch => ({
                  entries: batch.items.map((item) =>
                    toListEntry({ project, repository, item, viewer }),
                  ),
                  errors: [],
                  truncated: batch.truncated,
                }),
              ),
              // One unreachable repository must not blank the page, but a missing or
              // logged-out CLI is not repository-specific and stops the whole listing.
              Effect.catchIf(
                (error) => unavailableReason(error) === null,
                (error) =>
                  Effect.succeed<RepositoryBatch>({
                    entries: [],
                    errors: [
                      { projectId: project.id, projectTitle: project.title, message: error.detail },
                    ],
                    truncated: false,
                  }),
              ),
              Effect.mapError(toPullRequestError("list")),
            ),
        { concurrency: REPOSITORY_LIST_CONCURRENCY },
      );

      return {
        viewer,
        entries: batches
          .flatMap((batch) => batch.entries)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        errors: batches.flatMap((batch) => batch.errors),
        truncated: batches.some((batch) => batch.truncated),
      };
    });

  const detail: PullRequestService["Service"]["detail"] = (input) =>
    requireGitHubProject(input).pipe(
      Effect.flatMap(({ project, repository }) =>
        Effect.all(
          [
            github.getPullRequestDetail({
              cwd: project.workspaceRoot,
              repository,
              number: input.number,
            }),
            github.getRepositoryMergeCapabilities({ cwd: project.workspaceRoot, repository }),
            // Line comments live on review threads, which `gh pr view --json` cannot reach.
            // A GraphQL hiccup must not blank the whole detail, so it degrades to "none".
            github
              .listReviewThreadComments({
                cwd: project.workspaceRoot,
                repository,
                number: input.number,
              })
              .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: false }))),
          ],
          { concurrency: 3 },
        ).pipe(
          Effect.mapError(toPullRequestError("detail")),
          Effect.map(
            ([pullRequest, mergeCapabilities, reviewThreads]): PullRequestDetail => ({
              projectId: project.id,
              projectTitle: project.title,
              workspaceRoot: project.workspaceRoot,
              repository,
              number: pullRequest.number,
              title: pullRequest.title,
              body: pullRequest.body,
              url: pullRequest.url,
              author: pullRequest.author,
              state: pullRequest.state,
              isDraft: pullRequest.isDraft,
              mergeability: pullRequest.mergeability,
              additions: pullRequest.additions,
              deletions: pullRequest.deletions,
              changedFiles: pullRequest.changedFiles,
              headBranch: pullRequest.headBranch,
              baseBranch: pullRequest.baseBranch,
              createdAt: pullRequest.createdAt,
              updatedAt: pullRequest.updatedAt,
              mergedAt: pullRequest.mergedAt,
              closedAt: pullRequest.closedAt,
              reviewers: pullRequest.reviewRequestLogins.map((login) => ({ login, name: null })),
              labels: pullRequest.labels,
              checks: pullRequest.checks,
              comments: [...pullRequest.comments, ...reviewThreads.comments].toSorted(
                (left, right) => left.createdAt.localeCompare(right.createdAt),
              ),
              commentsTruncated:
                pullRequest.comments.length >= CONVERSATION_PAGE_SIZE || reviewThreads.truncated,
              commits: pullRequest.commits,
              mergeCapabilities,
            }),
          ),
        ),
      ),
    );

  const diff: PullRequestService["Service"]["diff"] = (input) =>
    requireGitHubProject(input).pipe(
      Effect.flatMap(({ project, repository }) =>
        github
          .getPullRequestDiff({
            cwd: project.workspaceRoot,
            repository,
            number: input.number,
          })
          .pipe(Effect.mapError(toPullRequestError("diff"))),
      ),
    );

  const runAction: PullRequestService["Service"]["runAction"] = (input) =>
    requireGitHubProject(input).pipe(
      Effect.flatMap(({ project, repository }) =>
        github
          .runPullRequestAction({
            cwd: project.workspaceRoot,
            repository,
            number: input.number,
            action: input.action,
            ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
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
      : requireGitHubProject(input)
    ).pipe(
      Effect.flatMap(({ project, repository }) =>
        github
          .commentOnPullRequest({
            cwd: project.workspaceRoot,
            repository,
            number: input.number,
            body: input.body,
          })
          .pipe(Effect.mapError(toPullRequestError("comment"))),
      ),
    );

  return PullRequestService.of({ list, detail, diff, runAction, comment });
});

export const layer = Layer.effect(PullRequestService, make);
