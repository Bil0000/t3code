import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type {
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  decodePullRequestDetailJson,
  decodePullRequestListJson,
  decodeRepositoryMergeCapabilitiesJson,
  decodeReviewThreadsJson,
  PULL_REQUEST_DETAIL_JSON_FIELDS,
  PULL_REQUEST_LIST_JSON_FIELDS,
  REPOSITORY_MERGE_CAPABILITIES_JSON_FIELDS,
  REVIEW_THREADS_GRAPHQL_QUERY,
  type GitHubPullRequestDetail,
  type GitHubPullRequestListItem,
  type GitHubReviewThreadComments,
} from "./gitHubPullRequestJson.ts";

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
}

export class GitHubPullRequestCli extends Context.Service<
  GitHubPullRequestCli,
  {
    readonly getViewerLogin: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitHubCli.GitHubCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubCli.GitHubCliError>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestDetail, GitHubCli.GitHubCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      GitHubCli.GitHubCliError
    >;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubCli.GitHubCliError>;

    readonly getRepositoryMergeCapabilities: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitHubCli.GitHubCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitHubCli.GitHubCliError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubCli.GitHubCliError>;
  }
>()("t3/pullRequest/GitHubPullRequestCli") {}

/** `owner/repo`, optionally host-qualified for GitHub Enterprise (`host/owner/repo`). */
export function isValidRepositorySelector(value: string): boolean {
  return /^(?:[a-z0-9.-]+\/)?[\w.-]+\/[\w.-]+$/i.test(value.trim());
}

function involvementArgs(input: {
  readonly state: PullRequestState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  // `--state closed` includes merged pull requests, so the Closed tab additionally excludes
  // them through search; `--author` and `review-requested:` are GitHub's own filters.
  const searchTerms = [
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(input.state === "closed" ? ["is:unmerged"] : []),
  ];
  return [
    ...(input.involvement === "authored" ? ["--author", input.viewer] : []),
    ...(searchTerms.length > 0 ? ["--search", searchTerms.join(" ")] : []),
  ];
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return ["merge", `--${mergeMethod ?? "merge"}`];
    case "ready":
      return ["ready"];
    case "draft":
      return ["ready", "--undo"];
    case "close":
      return ["close"];
    case "reopen":
      return ["reopen"];
  }
}

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  const decodeError = (cwd: string, cause: unknown) =>
    new GitHubCli.GitHubPullRequestDecodeError({ command: "gh", cwd, cause });

  const repositoryArgs = (repository: string) => ["--repo", repository];

  return GitHubPullRequestCli.of({
    getViewerLogin: (input) =>
      github.execute({ cwd: input.cwd, args: ["api", "user", "--jq", ".login"] }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          return login.length > 0
            ? Effect.succeed(login)
            : Effect.fail(decodeError(input.cwd, new Error("Empty viewer login.")));
        }),
      ),

    listPullRequests: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            ...repositoryArgs(input.repository),
            ...involvementArgs(input),
            "--state",
            input.state,
            "--limit",
            // One extra row reveals that the repository has more than the page shows.
            String(input.limit + 1),
            "--json",
            PULL_REQUEST_LIST_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const raw = result.stdout.trim();
            if (raw.length === 0) {
              return Effect.succeed({ items: [], truncated: false });
            }
            const decoded = decodePullRequestListJson(raw);
            return Result.isSuccess(decoded)
              ? Effect.succeed({
                  items: decoded.success.slice(0, input.limit),
                  truncated: decoded.success.length > input.limit,
                })
              : Effect.fail(decodeError(input.cwd, decoded.failure));
          }),
        ),

    getPullRequestDetail: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            String(input.number),
            ...repositoryArgs(input.repository),
            "--json",
            PULL_REQUEST_DETAIL_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodePullRequestDetailJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(decodeError(input.cwd, decoded.failure));
          }),
        ),

    getPullRequestDiff: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "diff",
            String(input.number),
            ...repositoryArgs(input.repository),
            "--color",
            "never",
            "--patch",
          ],
          maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        })
        .pipe(
          Effect.map((result) => ({
            patch: result.stdout,
            truncated: result.stdoutTruncated,
          })),
        ),

    listReviewThreadComments: (input) => {
      const [owner, name] = input.repository.split("/");
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "-f",
            `owner=${owner ?? ""}`,
            "-f",
            `name=${name ?? ""}`,
            "-F",
            `number=${input.number}`,
            "-f",
            `query=${REVIEW_THREADS_GRAPHQL_QUERY}`,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeReviewThreadsJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(decodeError(input.cwd, decoded.failure));
          }),
        );
    },

    getRepositoryMergeCapabilities: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "repo",
            "view",
            input.repository,
            "--json",
            REPOSITORY_MERGE_CAPABILITIES_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeRepositoryMergeCapabilitiesJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(decodeError(input.cwd, decoded.failure));
          }),
        ),

    runPullRequestAction: (input) => {
      const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            subcommand!,
            String(input.number),
            ...repositoryArgs(input.repository),
            ...flags,
          ],
        })
        .pipe(Effect.asVoid);
    },

    commentOnPullRequest: (input) =>
      github
        .execute({
          cwd: input.cwd,
          // The body travels over stdin: argv is visible in process listings and is echoed
          // back inside process-runner failure messages.
          args: [
            "pr",
            "comment",
            String(input.number),
            ...repositoryArgs(input.repository),
            "--body-file",
            "-",
          ],
          stdin: input.body,
        })
        .pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubPullRequestCli, make);
