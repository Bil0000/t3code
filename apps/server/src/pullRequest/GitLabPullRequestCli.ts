import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import {
  decodeCommitsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestListJson,
  decodeNotesJson,
  decodeProjectMergeCapabilitiesJson,
  decodeViewerJson,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestListItem,
} from "./gitLabMergeRequestJson.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitLabMergeRequestReadError extends Schema.TaggedErrorClass<GitLabMergeRequestReadError>()(
  "GitLabMergeRequestReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: glab answered, the account it answered for just has no username. */
export class GitLabViewerUnavailableError extends Schema.TaggedErrorClass<GitLabViewerUnavailableError>()(
  "GitLabViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export type GitLabPullRequestCliError =
  | GitLabCli.GitLabCliError
  | GitLabMergeRequestReadError
  | GitLabViewerUnavailableError;

/** GitLab's own ceiling on `per_page`, so a larger page has to be walked. */
const MAX_PAGE_SIZE = 100;
/** Conversation and commit history are read one page deep; the rest stays on GitLab. */
const CONVERSATION_PAGE_SIZE = 100;
/** Diff pages to walk before a change set is reported as truncated. */
const DIFF_MAX_PAGES = 3;
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly truncated: boolean;
}

export class GitLabPullRequestCli extends Context.Service<
  GitLabPullRequestCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitLabPullRequestCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    }) => Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError>;

    readonly getMergeRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>;

    readonly listNotes: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listCommits: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GitLabPullRequestCliError>;

    readonly getMergeRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly getProjectMergeCapabilities: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitLabPullRequestCliError>;

    readonly runMergeRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly commentOnMergeRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;
  }
>()("t3/pullRequest/GitLabPullRequestCli") {}

/** The REST API addresses a project by its URL-encoded full path. */
function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function stateParam(state: PullRequestState): string {
  // GitLab's `closed` already excludes merged merge requests, so no extra filter is needed.
  return state === "open" ? "opened" : state;
}

function involvementParams(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "reviewing":
      return [["reviewer_username", input.viewer]];
    case "all":
      return [];
  }
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return [
        "merge",
        // glab turns on auto-merge whenever a pipeline is running. The button means merge now.
        "--auto-merge=false",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
        ...(mergeMethod === "rebase" ? ["--rebase"] : []),
      ];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    case "reopen":
      return ["reopen"];
  }
}

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // A raw body from stdin: argv is visible in process listings and is echoed back
        // inside process-runner failure messages.
        ...(input.stdin === undefined ? [] : ["--input", "-"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

  /**
   * `per_page` stops at 100, so a larger page is walked one request at a time. The walk is
   * bounded twice over: it stops on a short page or once the extra row that reveals a next
   * page has been read, and it never asks for more pages than the caller's page needs. The
   * second bound is what makes it terminate when every row on a page fails to decode, which
   * leaves nothing collected but does not mean GitLab has run out of rows.
   */
  const listPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> => {
    // Fixed across the walk: GitLab pages by offset, so a page size that changed between
    // requests would skip or repeat rows. One row over the limit probes for a next page.
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const lastPage = Math.ceil((input.limit + 1) / perPage);
    return api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/merge_requests?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["per_page", String(perPage)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({ items: input.collected, truncated: false });
        }
        const decoded = decodeMergeRequestListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listMergeRequests",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.items];
        // Counted before decoding, so a skipped malformed row cannot end paging early.
        const exhausted = decoded.success.rawCount < perPage;
        if (exhausted || collected.length > input.limit || input.page >= lastPage) {
          return Effect.succeed({
            items: collected.slice(0, input.limit),
            // Anything but a short final page means GitLab may still have rows, including the
            // case where enough rows failed to decode to keep the collected count down.
            truncated: !exhausted || collected.length > input.limit,
          });
        }
        return listPage({ ...input, page: input.page + 1, collected });
      }),
    );
  };

  /**
   * A merge request's files come one page at a time, so the patch is assembled across pages.
   * The walk stops on a short page or at `DIFF_MAX_PAGES`; stopping on a full page means files
   * were left behind, which is what `truncated` tells the caller.
   */
  const diffPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly sections: ReadonlyArray<string>;
    /** GitLab withheld some file's hunks as too large to inline. */
    readonly withheld: boolean;
  }): Effect.Effect<
    { readonly patch: string; readonly truncated: boolean },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/diffs?${query(
        [
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
        ],
      )}`,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      timeoutMs: DIFF_TIMEOUT_MS,
    }).pipe(
      Effect.flatMap((result) => {
        const joined = (sections: ReadonlyArray<string>) =>
          sections.filter((section) => section.length > 0).join("\n");
        // Checked before decoding: a byte-truncated response is a JSON prefix, which would
        // fail to parse and lose the pages already read. What was read is worth returning.
        if (result.stdoutTruncated) {
          return Effect.succeed({ patch: joined(input.sections), truncated: true });
        }
        const decoded = decodeMergeRequestDiffsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiff",
              cause: decoded.failure,
            }),
          );
        }
        const sections = [...input.sections, decoded.success.patch];
        const withheld = input.withheld || decoded.success.truncated;
        const morePages = decoded.success.rawCount >= MAX_PAGE_SIZE;
        if (!morePages || input.page >= DIFF_MAX_PAGES) {
          return Effect.succeed({ patch: joined(sections), truncated: withheld || morePages });
        }
        return diffPage({ ...input, page: input.page + 1, sections, withheld });
      }),
    );

  return GitLabPullRequestCli.of({
    getViewerUsername: (input) =>
      api({ cwd: input.cwd, path: "user" }).pipe(
        Effect.flatMap((result): Effect.Effect<string, GitLabPullRequestCliError> => {
          const decoded = decodeViewerJson(result.stdout.trim());
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "getViewerUsername",
                cause: decoded.failure,
              }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new GitLabViewerUnavailableError({ command: "glab", cwd: input.cwd }))
            : Effect.succeed(decoded.success);
        }),
      ),

    listMergeRequests: (input) => listPage({ ...input, page: 1, collected: [] }),

    getMergeRequestDetail: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeMergeRequestDetailJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getMergeRequestDetail",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    listNotes: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes?${query(
          [
            ["per_page", String(CONVERSATION_PAGE_SIZE)],
            ["order_by", "created_at"],
            ["sort", "asc"],
          ],
        )}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeNotesJson(result.stdout.trim());
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "listNotes",
                cause: decoded.failure,
              }),
            );
          }
          return Effect.succeed({
            comments: decoded.success.comments,
            // The raw count, not the kept count: notes GitLab wrote itself are dropped, so a
            // full page of them would otherwise read as "no more notes".
            truncated: decoded.success.rawCount >= CONVERSATION_PAGE_SIZE,
          });
        }),
      ),

    listCommits: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/commits?${query(
          [["per_page", String(CONVERSATION_PAGE_SIZE)]],
        )}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCommitsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listCommits",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    getMergeRequestDiff: (input) => diffPage({ ...input, page: 1, sections: [], withheld: false }),

    getProjectMergeCapabilities: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}?license=false`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeProjectMergeCapabilitiesJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getProjectMergeCapabilities",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    runMergeRequestAction: (input) => {
      const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
      return gitlab
        .execute({
          cwd: input.cwd,
          args: ["mr", subcommand!, String(input.number), "--repo", input.repository, ...flags],
        })
        .pipe(Effect.asVoid);
    },

    commentOnMergeRequest: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes`,
        method: "POST",
        // A JSON body rather than a `--raw-field`: glab coerces a field that reads as a
        // literal `true` or a number, and a comment body is text either way.
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitLabPullRequestCli, make);
