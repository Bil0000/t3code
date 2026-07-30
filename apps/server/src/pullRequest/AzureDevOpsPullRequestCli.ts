import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestInvolvement,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import {
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeViewerJson,
  type AzureDevOpsPullRequest,
} from "./azureDevOpsPullRequestJson.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class AzureDevOpsPullRequestReadError extends Schema.TaggedErrorClass<AzureDevOpsPullRequestReadError>()(
  "AzureDevOpsPullRequestReadError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Azure CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: az answered, the account it answered for just has no name. */
export class AzureDevOpsViewerUnavailableError extends Schema.TaggedErrorClass<AzureDevOpsViewerUnavailableError>()(
  "AzureDevOpsViewerUnavailableError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "Azure CLI returned no account for the current sign-in.";
  }

  override get message(): string {
    return `Azure CLI failed in getViewer: ${this.detail}`;
  }
}

export type AzureDevOpsPullRequestCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsPullRequestReadError
  | AzureDevOpsViewerUnavailableError;

/** The version every REST call below is pinned to, so a new default cannot reshape a response. */
const REST_API_VERSION = "7.1";

export class AzureDevOpsPullRequestCli extends Context.Service<
  AzureDevOpsPullRequestCli,
  {
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, AzureDevOpsPullRequestCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<AzureDevOpsPullRequest>; readonly truncated: boolean },
      AzureDevOpsPullRequestCliError
    >;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestCliError>;

    /** Threads are not reachable through `az repos pr`, so they come from the REST API. */
    readonly listThreads: (input: {
      readonly cwd: string;
      readonly threadsUrl: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, AzureDevOpsPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
  }
>()("t3/pullRequest/AzureDevOpsPullRequestCli") {}

function statusArgs(state: PullRequestState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["--status", "active"];
    case "merged":
      return ["--status", "completed"];
    case "closed":
      return ["--status", "abandoned"];
  }
}

function involvementArgs(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  switch (input.involvement) {
    case "authored":
      return ["--creator", input.viewer];
    case "reviewing":
      return ["--reviewer", input.viewer];
    case "all":
      return [];
  }
}

/**
 * Azure moves a pull request by setting its state rather than by named commands: completing it
 * is the merge, abandoning it is the close, and reactivating it is the reopen. Squashing is a
 * completion option rather than a strategy of its own.
 */
function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return ["--status", "completed", "--squash", mergeMethod === "squash" ? "true" : "false"];
    case "ready":
      return ["--draft", "false"];
    case "draft":
      return ["--draft", "true"];
    case "close":
      return ["--status", "abandoned"];
    case "reopen":
      return ["--status", "active"];
  }
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  // Every command resolves the organization, project and repository from the checkout, which is
  // what the rest of the Azure wrapper does. The remote takes three shapes and only `az` knows
  // how to read all of them.
  const detectArgs = ["--detect", "true"] as const;

  const executeJson = (input: { readonly cwd: string; readonly args: ReadonlyArray<string> }) =>
    azure.execute({
      cwd: input.cwd,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  return AzureDevOpsPullRequestCli.of({
    getViewer: (input) =>
      executeJson({ cwd: input.cwd, args: ["account", "show", "--query", "user"] }).pipe(
        Effect.flatMap((result): Effect.Effect<string, AzureDevOpsPullRequestCliError> => {
          // `--query user` narrows the payload to the account, so it is nested back under the
          // key the decoder reads to keep one shape for the signed-in user.
          const decoded = decodeViewerJson(`{"user":${result.stdout.trim() || "null"}}`);
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new AzureDevOpsPullRequestReadError({
                command: "az",
                cwd: input.cwd,
                operation: "getViewer",
                cause: decoded.failure,
              }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new AzureDevOpsViewerUnavailableError({ command: "az", cwd: input.cwd }))
            : Effect.succeed(decoded.success);
        }),
      ),

    listPullRequests: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          ...detectArgs,
          "--repository",
          input.repository,
          ...statusArgs(input.state),
          ...involvementArgs(input),
          // A web link per row, which is the only url that needs no assembling.
          "--include-links",
          "--top",
          // One row over the page reveals that the repository has more than the page shows.
          String(input.limit + 1),
        ],
      }).pipe(
        Effect.flatMap((result) => {
          const raw = result.stdout.trim();
          if (raw.length === 0) {
            return Effect.succeed({ items: [], truncated: false });
          }
          const decoded = decodePullRequestListJson(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed({
                items: decoded.success.items.slice(0, input.limit),
                // Counted before decoding, so a skipped malformed row cannot end paging early.
                truncated: decoded.success.rawCount > input.limit,
              })
            : Effect.fail(
                new AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: input.cwd,
                  operation: "listPullRequests",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    getPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "pr", "show", ...detectArgs, "--id", String(input.number)],
      }).pipe(
        Effect.flatMap(
          (result): Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestCliError> => {
            const decoded = decodePullRequestJson(result.stdout.trim());
            // Null means Azure answered with too little to place the pull request, which is a
            // response this cannot use rather than one it can render partially.
            if (!Result.isSuccess(decoded) || decoded.success === null) {
              return Effect.fail(
                new AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: input.cwd,
                  operation: "getPullRequest",
                  cause: Result.isSuccess(decoded)
                    ? "Azure returned no branch or link for the pull request."
                    : decoded.failure,
                }),
              );
            }
            return Effect.succeed(decoded.success);
          },
        ),
      ),

    listThreads: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "rest",
          "--method",
          "get",
          "--url",
          `${input.threadsUrl}?api-version=${REST_API_VERSION}`,
        ],
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeThreadsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: input.cwd,
                  operation: "listThreads",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    runPullRequestAction: (input) =>
      azure
        .execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "update",
            ...detectArgs,
            "--id",
            String(input.number),
            ...actionArgs(input.action, input.mergeMethod),
            "--only-show-errors",
            "--output",
            "json",
          ],
        })
        .pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureDevOpsPullRequestCli, make);
