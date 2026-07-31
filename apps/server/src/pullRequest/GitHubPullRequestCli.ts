import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
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

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitHubPullRequestReadError extends Schema.TaggedErrorClass<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitHub CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: gh answered, the account it answered for just has no login. */
export class GitHubViewerLoginUnavailableError extends Schema.TaggedErrorClass<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitHub CLI returned no login for the authenticated account.";
  }

  override get message(): string {
    return `GitHub CLI failed in getViewerLogin: ${this.detail}`;
  }
}

export type GitHubPullRequestCliError =
  | GitHubCli.GitHubCliError
  | GitHubPullRequestReadError
  | GitHubViewerLoginUnavailableError;

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
    }) => Effect.Effect<string, GitHubPullRequestCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestDetail, GitHubPullRequestCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      GitHubPullRequestCliError
    >;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestCliError>;

    readonly getRepositoryMergeCapabilities: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitHubPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;
  }
>()("t3/pullRequest/GitHubPullRequestCli") {}

/**
 * `gh --repo` accepts the host-qualified form directly, but the GraphQL API takes owner and
 * name as separate arguments and the host as a flag, so the selector is split here.
 */
export function parseRepositorySelector(value: string): {
  readonly host: string | null;
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const owner = parts.at(-2) ?? "";
  return { host: parts.length > 2 ? (parts.at(-3) ?? null) : null, owner, name };
}

function involvementArgs(input: {
  readonly state: PullRequestListState;
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

  const repositoryArgs = (repository: string) => ["--repo", repository];

  return GitHubPullRequestCli.of({
    getViewerLogin: (input) =>
      github.execute({ cwd: input.cwd, args: ["api", "user", "--jq", ".login"] }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          return login.length > 0
            ? Effect.succeed(login)
            : Effect.fail(new GitHubViewerLoginUnavailableError({ command: "gh", cwd: input.cwd }));
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
                  items: decoded.success.items.slice(0, input.limit),
                  // One row over the page size is the probe for a next page, and it is
                  // counted before decoding: a skipped malformed row must not end paging.
                  truncated: decoded.success.rawCount > input.limit,
                })
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "listPullRequests",
                    cause: decoded.failure,
                  }),
                );
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
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "getPullRequestDetail",
                    cause: decoded.failure,
                  }),
                );
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
      const { host, owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            ...(host === null ? [] : ["--hostname", host]),
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
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
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "listReviewThreadComments",
                    cause: decoded.failure,
                  }),
                );
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
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "getRepositoryMergeCapabilities",
                    cause: decoded.failure,
                  }),
                );
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
