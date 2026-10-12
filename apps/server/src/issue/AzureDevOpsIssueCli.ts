import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  VcsProcessExitError,
  IssueAction,
  type IssueInvolvement,
  type IssueListState,
  type IssueListSort,
  type IssueListOrder,
  type IssueLabelCandidateList,
  type IssueAssigneeCandidateList,
  type IssueComment,
  type IssueEvent,
  type IssueReactionContent,
  type IssueLinkedPullRequest,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { azureDevOpsPullRequestWebUrl } from "@t3tools/source-control-azure-devops/server/azureDevOpsPullRequests";
import {
  decodeWorkItemJson,
  decodeWorkItemsJson,
  decodeWorkItemSummaryJson,
  decodeWorkItemCommentsJson,
  decodeWorkItemUpdatesJson,
  workItemUpdateEvents,
  AZURE_DEVOPS_COMMENT_REACTIONS,
  decodeLinkedPullRequestJson,
  azureDevOpsPullRequestArtifact,
  type AzureDevOpsWorkItem,
} from "./azureDevOpsIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class AzureDevOpsIssueReadError extends Schema.TaggedError<AzureDevOpsIssueReadError>()(
  "AzureDevOpsIssueReadError",
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

/** Not a decode failure: az answered with a work item that carries no title, date or link. */
export class AzureDevOpsWorkItemIncompleteError extends Schema.TaggedError<AzureDevOpsWorkItemIncompleteError>()(
  "AzureDevOpsWorkItemIncompleteError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "Azure DevOps returned a work item with no title, date or link.";
  }

  override get message(): string {
    return `Azure CLI failed in getWorkItem: ${this.detail}`;
  }
}

/** Not a decode failure either: az answered, and named no project for the checkout it ran in. */
export class AzureDevOpsProjectUnknownError extends Schema.TaggedError<AzureDevOpsProjectUnknownError>()(
  "AzureDevOpsProjectUnknownError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "Azure DevOps named no project for this checkout.";
  }

  override get message(): string {
    return `Azure CLI failed in resolveProject: ${this.detail}`;
  }
}

/**
 * Every state Azure refused for one action. Nothing in `az boards` reads a project's workflow, so
 * the names that were attempted travel with the refusal: a process template that spells its states
 * some other way is the one explanation a bare command failure cannot give, and the list says
 * exactly which name such a project would have to add.
 */
export class AzureDevOpsWorkItemStateRefusedError extends Schema.TaggedError<AzureDevOpsWorkItemStateRefusedError>()(
  "AzureDevOpsWorkItemStateRefusedError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    number: Schema.Int,
    action: IssueAction,
    states: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure DevOps refused every state that would ${this.action} work item ${this.number}: ${this.states.join(", ")}. Those are the states the out-of-the-box process templates use, and az reads no project's own workflow.`;
  }

  override get message(): string {
    return `Azure CLI failed in runWorkItemAction: ${this.detail}`;
  }
}

export type AzureDevOpsIssueCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | AzureDevOpsIssueReadError
  | AzureDevOpsProjectUnknownError
  | AzureDevOpsWorkItemIncompleteError
  | AzureDevOpsWorkItemStateRefusedError
  | AzureDevOpsIssueInputError
  | AzureDevOpsIssueWriteError
  | AzureDevOpsIssueMutationRefusedError;

export class AzureDevOpsIssueInputError extends Schema.TaggedError<AzureDevOpsIssueInputError>()(
  "AzureDevOpsIssueInputError",
  {
    reason: Schema.Literals([
      "missing-type",
      "too-many-assignees",
      "invalid-tag",
      "invalid-comment-id",
      "comment-required",
      "unsupported-reaction",
    ]),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "missing-type":
        return "Choose a work item type before creating an Azure DevOps work item.";
      case "too-many-assignees":
        return "Azure DevOps work items can have only one assignee.";
      case "invalid-tag":
        return "Azure DevOps tags cannot contain commas or semicolons, or exceed 400 characters.";
      case "invalid-comment-id":
        return "An Azure DevOps comment ID must be a positive 32-bit integer.";
      case "comment-required":
        return "Azure DevOps supports reactions on comments only.";
      case "unsupported-reaction":
        return "Azure DevOps does not support this comment reaction.";
    }
  }
}

export class AzureDevOpsIssueMutationRefusedError extends Schema.TaggedError<AzureDevOpsIssueMutationRefusedError>()(
  "AzureDevOpsIssueMutationRefusedError",
  { statusCode: Schema.Int, detail: Schema.String },
) {}

export class AzureDevOpsIssueWriteError extends Schema.TaggedError<AzureDevOpsIssueWriteError>()(
  "AzureDevOpsIssueWriteError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  get detail(): string {
    return "The Azure DevOps request file could not be prepared.";
  }
}

/**
 * Involvement as Azure can answer it. `mentioned` is left out rather than answered unnarrowed:
 * Azure records no mention of a person on a work item, so the only page this could hand back is
 * the whole project — and nothing between here and the reader narrows it back down.
 */
export type AzureDevOpsInvolvement = Exclude<IssueInvolvement, "mentioned">;

type AzureDevOpsIssueScope = {
  readonly cwd: string;
  readonly host?: string | undefined;
  readonly repository?: string | undefined;
};

export class AzureDevOpsIssueCli extends Context.Service<
  AzureDevOpsIssueCli,
  {
    readonly getViewer: (
      input: AzureDevOpsIssueScope,
    ) => Effect.Effect<string, AzureDevOpsIssueCliError>;
    readonly listWorkItems: (
      input: AzureDevOpsIssueScope & {
        readonly state: IssueListState;
        /** No `mentioned`: Azure records none, and the provider refuses that filter before here. */
        readonly involvement: AzureDevOpsInvolvement;
        readonly limit: number;
        readonly sort?: IssueListSort | undefined;
        readonly order?: IssueListOrder | undefined;
        readonly query?: string | undefined;
        readonly cursor?: ProviderListCursor | undefined;
      },
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<AzureDevOpsWorkItem>; readonly truncated: boolean },
      AzureDevOpsIssueCliError
    >;
    readonly getWorkItem: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
      },
    ) => Effect.Effect<AzureDevOpsWorkItem, AzureDevOpsIssueCliError>;
    readonly runWorkItemAction: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly action: IssueAction;
      },
    ) => Effect.Effect<void, AzureDevOpsIssueCliError>;
    readonly getWorkItemSummary: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
      },
    ) => Effect.Effect<
      Pick<AzureDevOpsWorkItem, "number" | "title" | "url" | "state">,
      AzureDevOpsIssueCliError
    >;
    readonly listComments: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly cursor?: string | undefined;
      },
    ) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<IssueComment>;
        readonly commentCount: number;
        readonly nextCursor: string | null;
      },
      AzureDevOpsIssueCliError
    >;
    readonly listUpdates: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly cursor?: string | undefined;
      },
    ) => Effect.Effect<
      {
        readonly events: ReadonlyArray<IssueEvent>;
        readonly eventsTruncated: boolean;
        readonly nextCursor: string | null;
      },
      AzureDevOpsIssueCliError
    >;
    readonly listLinkedPullRequests: (
      input: AzureDevOpsIssueScope & {
        readonly repository: string;
        readonly relations: NonNullable<AzureDevOpsWorkItem["relations"]>;
        readonly cursor?: string | undefined;
      },
    ) => Effect.Effect<
      {
        readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
        readonly linkedPullRequestsTruncated: boolean;
        readonly nextCursor: string | null;
      },
      AzureDevOpsIssueCliError
    >;
    readonly setReaction: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly subjectId?: string | undefined;
        readonly content: IssueReactionContent;
        readonly reacted: boolean;
      },
    ) => Effect.Effect<void, AzureDevOpsIssueCliError>;
    readonly comment: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly body: string;
        readonly commentId?: string | undefined;
      },
    ) => Effect.Effect<void, AzureDevOpsIssueCliError>;
    readonly createWorkItem: (
      input: AzureDevOpsIssueScope & {
        readonly title: string;
        readonly body: string;
        readonly labels: ReadonlyArray<string>;
        readonly assignees: ReadonlyArray<string>;
        readonly workItemType?: string | undefined;
      },
    ) => Effect.Effect<{ readonly number: number; readonly url: string }, AzureDevOpsIssueCliError>;
    readonly updateWorkItem: (
      input: AzureDevOpsIssueScope & {
        readonly number: number;
        readonly title?: string | undefined;
        readonly body?: string | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
        readonly assignees?: ReadonlyArray<string> | undefined;
      },
    ) => Effect.Effect<void, AzureDevOpsIssueCliError>;
    readonly listWorkItemTypes: (
      input: AzureDevOpsIssueScope,
    ) => Effect.Effect<ReadonlyArray<string>, AzureDevOpsIssueCliError>;
    readonly listTagCandidates: (
      input: AzureDevOpsIssueScope & { readonly number: number },
    ) => Effect.Effect<IssueLabelCandidateList, AzureDevOpsIssueCliError>;
    readonly listAssigneeCandidates: (
      input: AzureDevOpsIssueScope & { readonly number: number },
    ) => Effect.Effect<IssueAssigneeCandidateList, AzureDevOpsIssueCliError>;
  }
>()("t3/issue/AzureDevOpsIssueCli") {}

/**
 * The states a work item is moved into, written in order until Azure accepts one. Azure has no
 * close or reopen verb — a state is written like any other field — and `az boards` has no command
 * that reads a project's workflow. This is not discovery, then: it is a walk through the names
 * Microsoft documents for the four out-of-the-box process templates, Agile and CMMI first so those
 * projects still cost exactly one write.
 *
 * Closing: `Closed` on Agile and CMMI, `Done` on Scrum and Basic. Reopening: `Active` on Agile and
 * CMMI, `Committed` for Scrum's backlog items and `To Do` for its tasks, `Doing` on Basic — with
 * `New` and `Proposed` behind them for a workflow that allows no transition straight back into
 * work. A custom template can refuse all of them, and the refusal then names every one tried.
 */
const ACTION_STATES: Record<IssueAction, readonly [string, ...ReadonlyArray<string>]> = {
  close: ["Closed", "Done"],
  reopen: ["Active", "Committed", "Doing", "To Do", "New", "Proposed"],
};

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBatchResponse = decodeJsonResult(
  Schema.Struct({
    value: Schema.Tuple([Schema.Struct({ code: Schema.Int, body: Schema.String })]),
  }),
);
const decodeErrorBody = decodeJsonResult(
  Schema.Struct({ message: Schema.optional(Schema.String) }),
);

function involvementClause(involvement: AzureDevOpsInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    case "all":
      return "";
  }
}

/**
 * The names the decoder reads as closed, spelled the way Azure stores them. The two lists are one
 * decision: a state named here and not there — or the other way round — puts a work item in the
 * open list and then shows it as closed.
 */
function stateClause(state: IssueListState): string {
  switch (state) {
    case "open":
      return " AND [System.State] NOT IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')";
    case "closed":
      return " AND [System.State] IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')";
    case "all":
      return "";
  }
}

export const cursorOffset = (
  input: { readonly cwd: string; readonly cursor?: string | undefined },
  operation: string,
) => {
  if (input.cursor === undefined) return Effect.succeed(0);
  const offset = Number(input.cursor);
  return /^[1-9]\d*$/u.test(input.cursor) && Number.isSafeInteger(offset) && offset <= 2147483647
    ? Effect.succeed(offset)
    : Effect.fail(
        new AzureDevOpsIssueReadError({
          command: "az",
          cwd: input.cwd,
          operation,
          cause: "invalid-cursor",
        }),
      );
};

const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const fs = yield* FileSystem.FileSystem;

  const detectArgs = ["--detect", "true"] as const;
  const scopeArgs = (input: AzureDevOpsIssueScope) =>
    input.host && input.repository
      ? [
          "--detect",
          "false",
          "--organization",
          input.host.toLowerCase().endsWith(".visualstudio.com")
            ? `https://${input.host}`
            : `https://${input.host}/${encodeURIComponent(input.repository.split("/")[0]!)}`,
        ]
      : detectArgs;

  const execute = Effect.fn("AzureDevOpsIssueCli.execute")(function* (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const organizationIndex = input.args.indexOf("--organization");
    const organization = organizationIndex < 0 ? undefined : input.args[organizationIndex + 1];
    if (organization === undefined) return yield* azure.execute(input);
    const key = { provider: "azure-devops" as const, host: organization };
    const lease = yield* rateLimits.check(key);
    return yield* azure.execute(input).pipe(
      Effect.tapError((error) =>
        error._tag === "AzureDevOpsCliRateLimitError"
          ? Effect.gen(function* () {
              const retryAt =
                "retryAt" in error && typeof error.retryAt === "number"
                  ? error.retryAt
                  : "retryAfter" in error && typeof error.retryAfter === "string"
                    ? SourceControlRateLimit.retryAtFromHeader(
                        error.retryAfter,
                        yield* Clock.currentTimeMillis,
                      )
                    : undefined;
              yield* rateLimits.recordRateLimit({ ...key, lease, retryAt });
            })
          : Effect.void,
      ),
      Effect.tap(() => rateLimits.recordSuccess({ ...key, lease })),
    );
  });

  const executeJson = (input: { readonly cwd: string; readonly args: ReadonlyArray<string> }) =>
    execute({
      cwd: input.cwd,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) =>
    executeJson({ cwd: input.cwd, args: input.args }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new AzureDevOpsIssueReadError({
                command: "az",
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /**
   * The project the checkout belongs to, named rather than left to WIQL's `@project` macro:
   * `az boards query` runs at the organization, and never forwards a project to the query it
   * sends — so `@project` resolves to nothing and the answer spans every project in the
   * organization. Read from the repository the checkout points at, which is where `az` already
   * looks for everything else.
   */
  const projectName = (input: AzureDevOpsIssueScope) => {
    const project = input.repository?.split("/")[1];
    if (input.host && project) return Effect.succeed(project);
    const { cwd } = input;
    return execute({
      cwd,
      args: [
        "repos",
        "show",
        ...scopeArgs(input),
        "--query",
        "project.name",
        "--only-show-errors",
        "--output",
        "tsv",
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const name = result.stdout.trim();
        if (name.length > 0) return Effect.succeed(name);
        return Effect.fail(new AzureDevOpsProjectUnknownError({ command: "az", cwd }));
      }),
    );
  };

  const invokeArgs = (
    input: AzureDevOpsIssueScope,
    resource: string,
    project: string,
    route: ReadonlyArray<string> = [],
    version = "7.1",
  ) => [
    "devops",
    "invoke",
    ...scopeArgs(input),
    "--area",
    "wit",
    "--resource",
    resource,
    "--route-parameters",
    `project=${project}`,
    ...route,
    "--api-version",
    version,
  ];

  const writeJson = (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    body: unknown,
    mediaType = "application/json",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs
          .makeTempFileScoped({ prefix: "t3-azure-issue-" })
          .pipe(Effect.mapError((cause) => new AzureDevOpsIssueWriteError({ operation, cause })));
        yield* fs
          .writeFileString(file, encodeRequest(body))
          .pipe(Effect.mapError((cause) => new AzureDevOpsIssueWriteError({ operation, cause })));
        return yield* executeJson({
          cwd,
          args: [...args, "--in-file", file, "--media-type", mediaType],
        });
      }),
    );

  const getWorkItem = (input: AzureDevOpsIssueScope & { readonly number: number }) =>
    read({
      cwd: input.cwd,
      operation: "getWorkItem",
      args: [
        "boards",
        "work-item",
        "show",
        ...scopeArgs(input),
        "--id",
        String(input.number),
        "--expand",
        "relations",
      ],
      decode: decodeWorkItemJson,
    }).pipe(
      Effect.flatMap((item) =>
        item === null
          ? Effect.fail(
              new AzureDevOpsWorkItemIncompleteError({
                command: "az",
                cwd: input.cwd,
                number: input.number,
              }),
            )
          : Effect.succeed(item),
      ),
    );

  const itemProject = (input: AzureDevOpsIssueScope & { readonly number: number }) =>
    getWorkItem(input).pipe(
      Effect.flatMap((item) =>
        item.project === null ? projectName(input) : Effect.succeed(item.project),
      ),
    );

  const validateFields = (input: {
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  }) => {
    if ((input.assignees?.length ?? 0) > 1)
      return Effect.fail(new AzureDevOpsIssueInputError({ reason: "too-many-assignees" }));
    if (input.labels?.some((tag) => tag.length > 400 || /[,;]/u.test(tag)))
      return Effect.fail(new AzureDevOpsIssueInputError({ reason: "invalid-tag" }));
    return Effect.void;
  };

  const fieldPatch = (input: {
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  }) => [
    ...(input.title === undefined
      ? []
      : [{ op: "add", path: "/fields/System.Title", value: input.title }]),
    ...(input.body === undefined
      ? []
      : [
          { op: "add", path: "/fields/System.Description", value: input.body },
          { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        ]),
    ...(input.labels === undefined
      ? []
      : [{ op: "add", path: "/fields/System.Tags", value: input.labels.join("; ") }]),
    ...(input.assignees === undefined
      ? []
      : [{ op: "add", path: "/fields/System.AssignedTo", value: input.assignees[0] ?? "" }]),
  ];

  return AzureDevOpsIssueCli.of({
    getViewer: (input) =>
      read({
        cwd: input.cwd,
        operation: "getViewer",
        args: [
          "devops",
          "invoke",
          ...scopeArgs(input),
          "--area",
          "profile",
          "--resource",
          "profiles",
          "--route-parameters",
          "id=me",
          "--api-version",
          "7.1",
          "--query",
          "emailAddress || displayName || id",
        ],
        decode: decodeJsonResult(Schema.NonEmptyString),
      }),

    listWorkItems: (input) => {
      const cursorClause =
        input.cursor === undefined
          ? ""
          : ` AND [System.ChangedDate] <= ${quoted(input.cursor.updatedBefore)}` +
            (input.cursor.seenAt?.length
              ? ` AND [System.Id] NOT IN (${input.cursor.seenAt.join(",")})`
              : "");
      const sortField =
        input.sort === "created"
          ? "System.CreatedDate"
          : input.sort === "comments"
            ? "System.CommentCount"
            : "System.ChangedDate";
      const direction = input.order === "asc" ? "ASC" : "DESC";
      const query = (project: string) =>
        read({
          cwd: input.cwd,
          operation: "listWorkItems",
          args: [
            "boards",
            "query",
            ...scopeArgs(input),
            "--wiql",
            "SELECT [System.Id], [System.Title], [System.State], [System.CreatedDate], " +
              "[System.ChangedDate], [System.CreatedBy], [System.AssignedTo], [System.CommentCount], [System.Tags], [System.TeamProject] " +
              `FROM WorkItems WHERE [System.TeamProject] = ${quoted(project)}` +
              stateClause(input.state) +
              involvementClause(input.involvement) +
              (input.query?.trim()
                ? ` AND [System.Title] CONTAINS ${quoted(input.query.trim())}`
                : "") +
              cursorClause +
              ` ORDER BY [${sortField}] ${direction}, [System.Id] ASC`,
          ],
          decode: decodeWorkItemsJson,
        });

      return projectName(input).pipe(
        Effect.flatMap(query),
        Effect.map((page) => ({
          items: page.items.slice(0, input.limit),
          // Counted in rows this could read. A page that reports more without leaving a readable
          // row to carry on from is one the reader asks for again from the same place, forever.
          truncated: page.items.length > input.limit,
        })),
      );
    },

    getWorkItem,

    getWorkItemSummary: (input) =>
      read({
        cwd: input.cwd,
        operation: "getWorkItemSummary",
        args: [
          "boards",
          "work-item",
          "show",
          ...scopeArgs(input),
          "--id",
          String(input.number),
          "--fields",
          "System.Title,System.State,System.TeamProject",
          "--expand",
          "none",
        ],
        decode: decodeWorkItemSummaryJson,
      }).pipe(
        Effect.flatMap((item) =>
          item === null
            ? Effect.fail(
                new AzureDevOpsWorkItemIncompleteError({
                  command: "az",
                  cwd: input.cwd,
                  number: input.number,
                }),
              )
            : Effect.succeed(item),
        ),
      ),

    listComments: (input) =>
      itemProject(input).pipe(
        Effect.flatMap((project) =>
          read({
            cwd: input.cwd,
            operation: "listComments",
            args: [
              ...invokeArgs(
                input,
                "comments",
                project,
                [`workItemId=${input.number}`],
                "7.1-preview",
              ),
              "--query-parameters",
              "$top=100",
              "order=asc",
              "includeDeleted=false",
              "$expand=reactions",
              "api-version=7.1-preview.4",
              ...(input.cursor === undefined ? [] : [`continuationToken=${input.cursor}`]),
            ],
            decode: decodeWorkItemCommentsJson,
          }),
        ),
      ),

    listUpdates: Effect.fn("AzureDevOpsIssueCli.listUpdates")(function* (input) {
      const skip = yield* cursorOffset(input, "listUpdates");
      const project = yield* itemProject(input);
      const events: IssueEvent[] = [];
      const seen = new Set<number>();
      const page = yield* read({
        cwd: input.cwd,
        operation: "listUpdates",
        args: [
          ...invokeArgs(input, "updates", project, [`id=${input.number}`]),
          "--query-parameters",
          "$top=100",
          `$skip=${skip}`,
        ],
        decode: decodeWorkItemUpdatesJson,
      });
      if (
        page.value.length > 100 ||
        (page.value.length > 0 && page.value.every((update) => update.id <= skip))
      ) {
        return yield* new AzureDevOpsIssueReadError({
          command: "az",
          cwd: input.cwd,
          operation: "listUpdates",
          cause: page.value.length > 100 ? "oversized-page" : "repeated-page",
        });
      }
      for (const update of page.value) {
        if (update.id <= skip || seen.has(update.id)) continue;
        seen.add(update.id);
        events.push(...workItemUpdateEvents(update));
      }
      events.sort((left, right) => compareDateTimeStrings(left.createdAt, right.createdAt));
      const eventsTruncated = page.value.length > 0;
      return {
        events,
        eventsTruncated,
        nextCursor:
          eventsTruncated && skip + page.value.length <= 2147483647
            ? String(skip + page.value.length)
            : null,
      };
    }),

    listLinkedPullRequests: Effect.fn("AzureDevOpsIssueCli.listLinkedPullRequests")(
      function* (input) {
        const offset = yield* cursorOffset(input, "listLinkedPullRequests");
        const links = new Map<
          string,
          { project: string; repository: string; number: number; offset: number }
        >();
        for (const [index, relation] of input.relations.entries()) {
          const link = azureDevOpsPullRequestArtifact(relation);
          if (!link) continue;
          const key = `${link.project.toLowerCase()}/${link.repository.toLowerCase()}/${link.number}`;
          if (!links.has(key)) links.set(key, { ...link, offset: index + 1 });
        }
        const remaining = [...links.values()].filter((link) => link.offset > offset);
        const page = remaining.slice(0, 5);
        const linkedPullRequests = yield* Effect.forEach(
          page,
          (link) =>
            read({
              cwd: input.cwd,
              operation: "listLinkedPullRequests",
              args: [
                "devops",
                "invoke",
                ...scopeArgs(input),
                "--area",
                "git",
                "--resource",
                "pullrequests",
                "--route-parameters",
                `project=${link.project}`,
                `repositoryId=${link.repository}`,
                `pullRequestId=${link.number}`,
                "--api-version",
                "7.1",
                "--http-method",
                "GET",
              ],
              decode: decodeLinkedPullRequestJson,
            }).pipe(
              Effect.map((pr): IssueLinkedPullRequest => ({
                repository: `${input.repository.split("/")[0]}/${pr.repository.project.name}/${pr.repository.name}`,
                number: pr.pullRequestId,
                title: pr.title,
                url: azureDevOpsPullRequestWebUrl({
                  pullRequestId: pr.pullRequestId,
                  repositoryWebUrl: pr.repository.webUrl ?? pr.repository.remoteUrl,
                  restApiUrl: pr.url,
                  projectName: pr.repository.project.name,
                  repositoryName: pr.repository.name,
                }),
                state:
                  pr.status === "completed"
                    ? "merged"
                    : pr.status === "abandoned"
                      ? "closed"
                      : "open",
                isDraft: pr.isDraft ?? false,
                closesIssue: false,
              })),
              Effect.catchTags({
                AzureDevOpsPullRequestNotFoundError: () => Effect.succeed(null),
              }),
            ),
          { concurrency: 2 },
        );
        const linkedPullRequestsTruncated = remaining.length > page.length;
        return {
          linkedPullRequests: linkedPullRequests.filter((pr) => pr !== null),
          linkedPullRequestsTruncated,
          nextCursor: linkedPullRequestsTruncated ? String(page.at(-1)!.offset) : null,
        };
      },
    ),

    setReaction: (input) => {
      if (input.subjectId === undefined)
        return Effect.fail(new AzureDevOpsIssueInputError({ reason: "comment-required" }));
      if (!/^[1-9]\d*$/u.test(input.subjectId) || Number(input.subjectId) > 2147483647)
        return Effect.fail(new AzureDevOpsIssueInputError({ reason: "invalid-comment-id" }));
      const type = Object.entries(AZURE_DEVOPS_COMMENT_REACTIONS).find(
        ([, content]) => content === input.content,
      )?.[0];
      if (type === undefined)
        return Effect.fail(new AzureDevOpsIssueInputError({ reason: "unsupported-reaction" }));
      return itemProject(input).pipe(
        Effect.flatMap((project) =>
          executeJson({
            cwd: input.cwd,
            args: [
              ...invokeArgs(
                input,
                "commentsReactions",
                project,
                [
                  `workItemId=${input.number}`,
                  `commentId=${input.subjectId}`,
                  `reactionType=${type}`,
                ],
                "7.1-preview",
              ),
              "--http-method",
              input.reacted ? "PUT" : "DELETE",
              "--query-parameters",
              "api-version=7.1-preview.1",
            ],
          }),
        ),
        Effect.asVoid,
      );
    },

    comment: (input) => {
      if (input.commentId !== undefined && !/^[1-9]\d*$/u.test(input.commentId))
        return Effect.fail(new AzureDevOpsIssueInputError({ reason: "invalid-comment-id" }));
      return itemProject(input).pipe(
        Effect.flatMap((project) =>
          writeJson(
            input.cwd,
            "comment",
            [
              ...invokeArgs(
                input,
                "comments",
                project,
                [
                  `workItemId=${input.number}`,
                  ...(input.commentId === undefined ? [] : [`commentId=${input.commentId}`]),
                ],
                "7.1-preview",
              ),
              "--http-method",
              input.commentId === undefined ? "POST" : "PATCH",
              "--query-parameters",
              "format=markdown",
            ],
            { text: input.body },
          ),
        ),
        Effect.asVoid,
      );
    },

    createWorkItem: (input) => {
      if (!input.workItemType?.trim())
        return Effect.fail(new AzureDevOpsIssueInputError({ reason: "missing-type" }));
      const workItemType = input.workItemType;
      return validateFields(input).pipe(
        Effect.andThen(projectName(input)),
        Effect.flatMap((project) =>
          writeJson(
            input.cwd,
            "createWorkItem",
            [
              ...invokeArgs(input, "workitems", project, [
                `type=${workItemType}`,
                `id=$${workItemType}`,
              ]),
              "--http-method",
              "POST",
            ],
            fieldPatch(input),
            "application/json-patch+json",
          ),
        ),
        Effect.flatMap((result) => {
          const decoded = decodeWorkItemSummaryJson(result.stdout);
          if (Result.isFailure(decoded))
            return Effect.fail(
              new AzureDevOpsIssueReadError({
                command: "az",
                cwd: input.cwd,
                operation: "createWorkItem",
                cause: decoded.failure,
              }),
            );
          if (decoded.success === null)
            return Effect.fail(
              new AzureDevOpsIssueReadError({
                command: "az",
                cwd: input.cwd,
                operation: "createWorkItem",
                cause: "incomplete-response",
              }),
            );
          return Effect.succeed({ number: decoded.success.number, url: decoded.success.url });
        }),
      );
    },

    updateWorkItem: (input) =>
      validateFields(input).pipe(
        Effect.andThen(projectName(input)),
        Effect.flatMap((project) =>
          writeJson(
            input.cwd,
            "updateWorkItem",
            [...invokeArgs(input, "batch", project, [], "4.1"), "--http-method", "PATCH"],
            [
              {
                method: "PATCH",
                uri: `/${encodeURIComponent(project)}/_apis/wit/workitems/${input.number}?api-version=7.1`,
                headers: { "Content-Type": "application/json-patch+json" },
                body: fieldPatch(input),
              },
            ],
            "application/json",
          ),
        ),
        Effect.flatMap((result): Effect.Effect<void, AzureDevOpsIssueCliError> => {
          const decoded = decodeBatchResponse(result.stdout);
          if (Result.isFailure(decoded))
            return Effect.fail(
              new AzureDevOpsIssueReadError({
                command: "az",
                cwd: input.cwd,
                operation: "updateWorkItem",
                cause: decoded.failure,
              }),
            );
          const response = decoded.success.value[0];
          if (response.code >= 200 && response.code < 300) return Effect.void;
          const error = decodeErrorBody(response.body);
          return Effect.fail(
            new AzureDevOpsIssueMutationRefusedError({
              statusCode: response.code,
              detail: Result.isSuccess(error)
                ? (error.success.message ??
                  `Azure DevOps refused the update (HTTP ${response.code}).`)
                : `Azure DevOps refused the update (HTTP ${response.code}).`,
            }),
          );
        }),
      ),

    listWorkItemTypes: (input) =>
      projectName(input).pipe(
        Effect.flatMap((project) =>
          read({
            cwd: input.cwd,
            operation: "listWorkItemTypes",
            args: invokeArgs(input, "workitemtypes", project),
            decode: decodeJsonResult(
              Schema.Struct({
                value: Schema.Array(
                  Schema.Struct({
                    name: Schema.NonEmptyString,
                    isDisabled: Schema.optional(Schema.Boolean),
                  }),
                ),
              }),
            ),
          }),
        ),
        Effect.map((page) =>
          page.value.filter((item) => !item.isDisabled).map((item) => item.name),
        ),
      ),

    listTagCandidates: (input) =>
      getWorkItem(input).pipe(
        Effect.flatMap((item) =>
          (item.project === null ? projectName(input) : Effect.succeed(item.project)).pipe(
            Effect.flatMap((project) =>
              read({
                cwd: input.cwd,
                operation: "listTagCandidates",
                args: invokeArgs(input, "tags", project),
                decode: decodeJsonResult(
                  Schema.Struct({
                    value: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
                  }),
                ),
              }),
            ),
            Effect.map((page) => ({
              candidates: [
                ...new Set([
                  ...page.value.map((tag) => tag.name),
                  ...item.labels.map((tag) => tag.name),
                ]),
              ].map((name) => ({
                name,
                color: null,
                description: null,
                isApplied: item.labels.some((tag) => tag.name === name),
              })),
              truncated: false,
            })),
          ),
        ),
      ),

    listAssigneeCandidates: (input) =>
      Effect.gen(function* () {
        const item = yield* getWorkItem(input);
        const project = item.project ?? (yield* projectName(input));
        const teams = yield* read({
          cwd: input.cwd,
          operation: "listTeams",
          args: [
            "devops",
            "team",
            "list",
            ...scopeArgs(input),
            "--project",
            project,
            "--top",
            "10",
          ],
          decode: decodeJsonResult(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))),
        });
        const members = yield* Effect.forEach(
          teams,
          (team) =>
            read({
              cwd: input.cwd,
              operation: "listTeamMembers",
              args: [
                "devops",
                "team",
                "list-member",
                ...scopeArgs(input),
                "--project",
                project,
                "--team",
                team.id,
                "--top",
                "100",
              ],
              decode: decodeJsonResult(
                Schema.Array(
                  Schema.Struct({
                    identity: Schema.Struct({
                      uniqueName: Schema.NonEmptyString,
                      displayName: Schema.optional(Schema.String),
                      imageUrl: Schema.optional(Schema.String),
                      isContainer: Schema.optional(Schema.Boolean),
                    }),
                  }),
                ),
              ),
            }),
          { concurrency: 3 },
        );
        const candidates = new Map(
          item.assignees.map((actor) => [
            actor.login.toLowerCase(),
            { ...actor, id: actor.login, isAssigned: true },
          ]),
        );
        for (const member of members.flat()) {
          const identity = member.identity;
          if (identity.isContainer || candidates.has(identity.uniqueName.toLowerCase())) continue;
          candidates.set(identity.uniqueName.toLowerCase(), {
            id: identity.uniqueName,
            login: identity.uniqueName,
            name: identity.displayName ?? null,
            avatarUrl: identity.imageUrl ?? null,
            isAssigned: false,
          });
        }
        return { candidates: [...candidates.values()], truncated: true };
      }),

    runWorkItemAction: (input) => {
      const write = (
        state: string,
        remaining: ReadonlyArray<string>,
      ): Effect.Effect<void, AzureDevOpsIssueCliError> =>
        executeJson({
          cwd: input.cwd,
          args: [
            "boards",
            "work-item",
            "update",
            ...scopeArgs(input),
            "--id",
            String(input.number),
            "--state",
            state,
          ],
        }).pipe(
          Effect.asVoid,
          // Only the failure az reports for a rule it broke moves on to the next name. An unusable
          // tool, an unauthenticated one and a work item that is not there arrive under their own
          // tags: they keep their own explanation, and no other state is written after them.
          Effect.catchTags({
            AzureDevOpsCommandFailedError: (error) => {
              if (
                !Schema.is(VcsProcessExitError)(error.cause) ||
                error.cause.failureKind !== "state-rule"
              ) {
                return Effect.fail(error);
              }
              const [next, ...following] = remaining;
              return next === undefined
                ? Effect.fail(
                    new AzureDevOpsWorkItemStateRefusedError({
                      command: "az",
                      cwd: input.cwd,
                      number: input.number,
                      action: input.action,
                      states: ACTION_STATES[input.action],
                      cause: error,
                    }),
                  )
                : write(next, following);
            },
          }),
        );

      const [first, ...rest] = ACTION_STATES[input.action];
      return write(first, rest);
    },
  });
});

export const layer = Layer.effect(AzureDevOpsIssueCli, make);
