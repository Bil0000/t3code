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
  PullRequestReviewCommentDraft,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  ACTOR_AVATARS_GRAPHQL_QUERY,
  buildReviewSubmissionJson,
  decodeActorAvatarsJson,
  decodePullRequestDetailJson,
  decodePullRequestFilesJson,
  decodePullRequestListJson,
  decodeRepositoryMergeCapabilitiesJson,
  decodeReviewThreadsJson,
  encodeGraphQlRequestJson,
  PULL_REQUEST_DETAIL_JSON_FIELDS,
  PULL_REQUEST_LIST_JSON_FIELDS,
  REPOSITORY_MERGE_CAPABILITIES_JSON_FIELDS,
  RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
  REVIEW_THREADS_GRAPHQL_QUERY,
  UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
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

/** Not a decode failure: the reader asked to carry on from a cursor this walk never handed out. */
export class GitHubDiffCursorError extends Schema.TaggedErrorClass<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The diff cursor was not one this pull request handed out.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestDiff: ${this.detail}`;
  }
}

export type GitHubPullRequestCliError =
  | GitHubCli.GitHubCliError
  | GitHubPullRequestReadError
  | GitHubDiffCursorError
  | GitHubViewerLoginUnavailableError;

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;

/** What the files API serves at most in one response, which is what one slice is made of. */
const DIFF_FILES_PAGE_SIZE = 100;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  /** Where the next slice starts, or null once the patch is whole. */
  readonly nextCursor: string | null;
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
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestDetail, GitHubPullRequestCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Absent asks for the first slice; anything else is a cursor a slice handed back. */
      readonly cursor?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError>;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestCliError>;

    /** One request for a listing's authors, since no `gh` JSON field reports an avatar. */
    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestCliError>;

    readonly getRepositoryMergeCapabilities: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitHubPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;
  }
>()("t3/pullRequest/GitHubPullRequestCli") {}

/**
 * The GraphQL API takes owner and name as separate arguments, so `owner/repo` is split here.
 * The host is not read off the identity: it travels alongside it, because the identity a
 * project records is the path below its host and never names the host itself.
 */
export function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/**
 * The page a diff cursor names, or null for anything this walk cannot have issued. The cursor
 * arrives from the reader as a string and goes straight into a request path, so it is parsed
 * rather than trusted; the length bound keeps a page number out of exponential notation.
 */
function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
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

  // `gh` resolves a bare `owner/repo` against whichever host it defaults to, which is
  // github.com. Naming the host makes a GitHub Enterprise repository resolve to its own
  // install rather than to a same-named repository on github.com.
  const repositoryArgs = (input: { readonly host: string; readonly repository: string }) => [
    "--repo",
    `${input.host}/${input.repository}`,
  ];

  /**
   * A GraphQL mutation whose answer is not read back. `gh` exits non-zero on a GraphQL error,
   * so a failed mutation is already a failed command rather than a body to inspect.
   *
   * The query and its variables travel over stdin as one document: a variable can carry a
   * body the reader wrote, and argv is visible in process listings and echoed back inside
   * process-runner failure messages.
   */
  const graphql = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
        stdin: encodeGraphQlRequestJson({ query: input.query, variables: input.variables }),
      })
      .pipe(Effect.asVoid);

  /**
   * One page of the patch, read from the files API. GitHub refuses `pr diff` outright past 300
   * changed files, and still serves those files' hunks here.
   *
   * A page is a whole number of files, so each one parses on its own; the caller carries on from
   * `nextCursor` for as long as GitHub keeps handing pages back.
   */
  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          `repos/${owner}/${name}/pulls/${input.number}/files?per_page=${DIFF_FILES_PAGE_SIZE}&page=${input.page}`,
        ],
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
        timeoutMs: DIFF_TIMEOUT_MS,
      })
      .pipe(
        Effect.flatMap((result) => {
          // Checked before decoding: a byte-truncated response is a JSON prefix, which would
          // fail to parse. Nothing of this page can be shown, and an empty patch would render
          // as a change with no files rather than as the failure it is; slices already handed
          // over stay with the reader either way.
          if (result.stdoutTruncated) {
            return Effect.fail(
              new GitHubPullRequestReadError({
                command: "gh",
                cwd: input.cwd,
                operation: "getPullRequestDiff",
                cause: new Error(`Page ${input.page} of the changed files was too large to read.`),
              }),
            );
          }
          const decoded = decodePullRequestFilesJson(result.stdout.trim());
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new GitHubPullRequestReadError({
                command: "gh",
                cwd: input.cwd,
                operation: "getPullRequestDiff",
                cause: decoded.failure,
              }),
            );
          }
          // Counted before decoding, so a page whose files all failed to decode still moves on
          // rather than pointing the reader back at the page it just read.
          const morePages = decoded.success.rawCount >= DIFF_FILES_PAGE_SIZE;
          return Effect.succeed({
            patch: decoded.success.patch,
            truncated: decoded.success.truncated,
            nextCursor: morePages ? String(input.page + 1) : null,
          });
        }),
      );
  };

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
            ...repositoryArgs(input),
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
            ...repositoryArgs(input),
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

    getPullRequestDiff: (input) => {
      const filesPage = (page: number) =>
        diffFilesPage({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          page,
        });
      // A cursor only ever comes from the files walk, so a reader carrying one is already past
      // the point where `gh pr diff` had anything to say.
      if (input.cursor !== undefined) {
        const page = diffCursorPage(input.cursor);
        return page === null
          ? Effect.fail(new GitHubDiffCursorError({ command: "gh", cwd: input.cwd }))
          : filesPage(page);
      }
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "diff",
            String(input.number),
            ...repositoryArgs(input),
            "--color",
            "never",
            "--patch",
          ],
          maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        })
        .pipe(
          Effect.flatMap((result) =>
            // A patch cut at a byte boundary ends mid-file, which is neither a whole slice nor
            // something the reader can carry on from. The files API can serve the same change a
            // whole number of files at a time, so an oversized patch takes that road as well.
            result.stdoutTruncated
              ? filesPage(1)
              : // One read served the whole patch, so there is no next slice to ask for.
                Effect.succeed({ patch: result.stdout, truncated: false, nextCursor: null }),
          ),
          // GitHub answers 406 rather than a diff past 300 changed files, so the patch is read
          // from the files API instead, a page per call. Only once the direct read has failed: a
          // pull request GitHub will serve a diff for must not pay for a second request. A
          // fallback that fails too reports the original refusal, which is the one that explains
          // the page. Narrowed to a command that ran and was refused: a missing `gh` or a
          // signed-out one fails the same way for every request.
          Effect.catchTag("GitHubCliCommandError", (error) =>
            filesPage(1).pipe(Effect.catch(() => Effect.fail(error))),
          ),
        );
    },

    listReviewThreadComments: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "--hostname",
            input.host,
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

    listActorAvatars: (input) => {
      if (input.ids.length === 0) {
        return Effect.succeed(new Map<string, string>());
      }
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "--hostname",
            input.host,
            ...input.ids.flatMap((id) => ["-f", `ids[]=${id}`]),
            "-f",
            `query=${ACTOR_AVATARS_GRAPHQL_QUERY}`,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeActorAvatarsJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "listActorAvatars",
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
            `${input.host}/${input.repository}`,
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
          args: ["pr", subcommand!, String(input.number), ...repositoryArgs(input), ...flags],
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
            ...repositoryArgs(input),
            "--body-file",
            "-",
          ],
          stdin: input.body,
        })
        .pipe(Effect.asVoid),

    submitReview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          // The whole review is one request, so nothing is visible to anyone else until the
          // verdict is sent. The payload travels over stdin for the same reason a comment
          // body does: argv is visible in process listings and echoed back in failures.
          args: [
            "api",
            "--method",
            "POST",
            "--hostname",
            input.host,
            `repos/${owner}/${name}/pulls/${input.number}/reviews`,
            "--input",
            "-",
          ],
          stdin: buildReviewSubmissionJson({
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          }),
        })
        .pipe(Effect.asVoid);
    },

    replyToReviewThread: (input) =>
      graphql({
        cwd: input.cwd,
        host: input.host,
        query: REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId, body: input.body },
      }),

    setReviewThreadResolution: (input) =>
      graphql({
        cwd: input.cwd,
        host: input.host,
        query: input.resolved
          ? RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION
          : UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId },
      }),
  });
});

export const layer = Layer.effect(GitHubPullRequestCli, make);
