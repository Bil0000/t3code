import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueAction, IssueInvolvement, IssueListState } from "@t3tools/contracts";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import {
  decodeWorkItemJson,
  decodeWorkItemsJson,
  type AzureDevOpsWorkItem,
} from "./azureDevOpsIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class AzureDevOpsIssueReadError extends Schema.TaggedErrorClass<AzureDevOpsIssueReadError>()(
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
export class AzureDevOpsWorkItemIncompleteError extends Schema.TaggedErrorClass<AzureDevOpsWorkItemIncompleteError>()(
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

export type AzureDevOpsIssueCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsIssueReadError
  | AzureDevOpsWorkItemIncompleteError;

export class AzureDevOpsIssueCli extends Context.Service<
  AzureDevOpsIssueCli,
  {
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, AzureDevOpsIssueCliError>;
    readonly listWorkItems: (input: {
      readonly cwd: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly limit: number;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<AzureDevOpsWorkItem>; readonly truncated: boolean },
      AzureDevOpsIssueCliError
    >;
    readonly getWorkItem: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsWorkItem, AzureDevOpsIssueCliError>;
    readonly runWorkItemAction: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, AzureDevOpsIssueCliError>;
  }
>()("t3/issue/AzureDevOpsIssueCli") {}

/**
 * The state a work item is moved into. Azure has no close or reopen verb — a state is written
 * like any other field — and the two names below are the ones every out-of-the-box process
 * template shares. A project that renamed its columns is refused by Azure itself, which names
 * the states it does have.
 */
const ACTION_STATES: Record<IssueAction, string> = { close: "Closed", reopen: "Active" };

/** WIQL has one quote to escape, and a title filter never reaches it — but a cursor does. */
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

function involvementClause(involvement: IssueInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    // Azure records no mention of a person on a work item, so the whole project is answered and
    // the caller narrows what it gets — a wider answer rather than a wrong one.
    case "mentioned":
    case "all":
      return "";
  }
}

function stateClause(state: IssueListState): string {
  switch (state) {
    case "open":
      return " AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')";
    case "closed":
      return " AND [System.State] IN ('Closed', 'Done', 'Removed', 'Resolved')";
    case "all":
      return "";
  }
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  // Every command resolves the organization and project from the checkout, which is what the
  // rest of the Azure wrapper does: the remote takes three shapes and only `az` reads all of them.
  const detectArgs = ["--detect", "true"] as const;

  const executeJson = (input: { readonly cwd: string; readonly args: ReadonlyArray<string> }) =>
    azure.execute({
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
  const projectName = (cwd: string) =>
    azure
      .execute({
        cwd,
        args: [
          "repos",
          "show",
          ...detectArgs,
          "--query",
          "project.name",
          "--only-show-errors",
          "--output",
          "tsv",
        ],
      })
      .pipe(
        Effect.flatMap((result) => {
          const name = result.stdout.trim();
          return name.length === 0
            ? Effect.fail(
                new AzureDevOpsIssueReadError({
                  command: "az",
                  cwd,
                  operation: "resolveProject",
                  cause: new Error("Azure CLI named no project for this checkout."),
                }),
              )
            : Effect.succeed(name);
        }),
      );

  return AzureDevOpsIssueCli.of({
    getViewer: (input) =>
      read({
        cwd: input.cwd,
        operation: "getViewer",
        args: ["account", "show", "--query", "user.name"],
        decode: (raw) => Result.succeed(raw.trim().replaceAll('"', "")),
      }),

    listWorkItems: (input) => {
      // Asked for one row beyond the page, which is how every provider here probes for a next
      // slice without a second request.
      const top = input.limit + 1;
      const cursorClause =
        input.cursor === undefined
          ? ""
          : ` AND [System.ChangedDate] <= ${quoted(input.cursor.updatedBefore)}`;
      return projectName(input.cwd).pipe(
        Effect.flatMap((project) =>
          read({
            cwd: input.cwd,
            operation: "listWorkItems",
            // The query travels as one argv value rather than through a shell, and carries no
            // text the reader typed: Azure filters by no free text, so a search never reaches it.
            args: [
              "boards",
              "query",
              ...detectArgs,
              "--wiql",
              `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quoted(project)}` +
                stateClause(input.state) +
                involvementClause(input.involvement) +
                cursorClause +
                " ORDER BY [System.ChangedDate] DESC",
              "--top",
              String(top),
            ],
            decode: decodeWorkItemsJson,
          }),
        ),
        Effect.map((page) => ({
          items: page.items.slice(0, input.limit),
          truncated: page.rawCount > input.limit,
        })),
      );
    },

    getWorkItem: (input) =>
      read({
        cwd: input.cwd,
        operation: "getWorkItem",
        args: ["boards", "work-item", "show", "--id", String(input.number)],
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
      ),

    runWorkItemAction: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "boards",
          "work-item",
          "update",
          "--id",
          String(input.number),
          "--state",
          ACTION_STATES[input.action],
        ],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureDevOpsIssueCli, make);
