/**
 * Azure DevOps work items as an issue tracker, over the same `az` the pull request reads use.
 *
 * Work items belong to a project rather than a repository, so the scope is `organization/project`
 * and every call names the organization explicitly instead of detecting it from the checkout.
 * Listing is a WIQL query with `timePrecision`, paged by a `(changedDate, id)` keyset cursor
 * because WIQL has no offset; the rest of the reads are `az boards` commands and `wit` REST
 * routes reached through `az devops invoke`, which signs in the way the extension does.
 *
 * @module source-control-azure-devops/server/AzureDevOpsIssueTracker
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueWorkflowCategory,
  type IssueState,
  type IssueRelation,
  type IssuePageInput,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueScopeTarget,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  azureDevOpsReactionType,
  decodeCommentsJson,
  decodeProfileJson,
  decodeUpdatesJson,
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
  type AzureDevOpsWorkItem,
} from "./azureDevOpsIssueJson.ts";
import { decodePullRequestJson } from "./azureDevOpsPullRequestJson.ts";

const KIND = IssueTrackerKind.make("azure-devops");

/**
 * The states the stock Basic, Agile and Scrum processes carry, which is what a project that has
 * not customised its workflow can be moved between. A project with states of its own refuses a
 * name it lacks at write time, with Azure's own message.
 */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  listSorts: ["created", "updated", "comments"],
  listOrders: ["asc", "desc"],
  labels: true,
  assignees: true,
  maxAssignees: 1,
  reactions: false,
  commentReactions: true,
  reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
  templates: true,
  createIssueTypes: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  involvements: ["all", "assigned", "authored"],
  states: [
    { category: "open", name: "New" },
    { category: "open", name: "To Do" },
    { category: "open", name: "Active" },
    { category: "open", name: "Doing" },
    { category: "closed", name: "Resolved" },
    { category: "closed", name: "Done" },
    { category: "closed", name: "Closed" },
    { category: "closed", name: "Removed" },
  ],
  closeReasons: [],
};

/**
 * Everything granted. Azure states no permission anywhere `az boards` reaches: the answer lives
 * in the security namespaces, behind identity descriptors that would be several calls per work
 * item to resolve. Controls stay live and a viewer who may not use one is told so by Azure.
 */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const WORKFLOW_CATEGORY: Readonly<Record<string, IssueWorkflowCategory>> = {
  Proposed: "unstarted",
  InProgress: "started",
  Resolved: "started",
  Completed: "completed",
  Removed: "canceled",
};
const WorkItemTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  workItemTypeName: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
});
const decodeListCursor = Schema.decodeUnknownResult(
  Schema.Struct({
    sort: Schema.Literals(["created", "updated", "comments"]),
    order: Schema.Literals(["asc", "desc"]),
    id: Schema.Int.check(Schema.isGreaterThan(0)),
    value: Schema.Union([
      Schema.String,
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    ]),
  }),
);
const REST_API_VERSION = "7.1";
const PAGE_SIZE = 100;
/** Linked pull requests are read one `az` process each, so a work item's links are bounded. */
const LINKED_PULL_REQUEST_LIMIT = 10;
/** Which work item type a new issue is filed as, in order of preference across the stock processes. */
const CREATE_TYPES = ["Issue", "Bug", "Task", "User Story", "Product Backlog Item"];

const LIST_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.CreatedBy",
  "System.AssignedTo",
  "System.CommentCount",
  "System.Tags",
  "System.TeamProject",
  "Microsoft.VSTS.Common.ClosedDate",
];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWiql = Schema.decodeUnknownResult(
  Schema.Struct({
    asOf: Schema.optional(Schema.String),
    workItems: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.Int })))),
  }),
);
const WorkItemTypes = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      isDisabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
      states: Schema.optional(
        Schema.NullOr(
          Schema.Array(Schema.Struct({ name: Schema.String, category: Schema.String })),
        ),
      ),
    }),
  ),
});
const decodeTypes = Schema.decodeUnknownResult(WorkItemTypes);
const decodeTags = Schema.decodeUnknownResult(
  Schema.Struct({ value: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);

const decodeMembers = Schema.decodeUnknownResult(
  Schema.Array(
    Schema.Struct({
      identity: Schema.Struct({
        uniqueName: Schema.String,
        displayName: Schema.optional(Schema.NullOr(Schema.String)),
        imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
        isContainer: Schema.optional(Schema.Boolean),
      }),
    }),
  ),
);
const decodeUnknown = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** The parts of an `organization/project` scope, as the organization URL and the project name. */
function parseScope(
  host: string,
  scope: string,
): { readonly organization: string; readonly project: string } | null {
  const parts = scope.split("/").flatMap((part) => part.trim() || []);
  if (parts.length !== 2) return null;
  const [organization, project] = parts as [string, string];
  return {
    organization: host.toLowerCase().endsWith(".visualstudio.com")
      ? `https://${host}`
      : `https://${host}/${encodeURIComponent(organization)}`,
    project,
  };
}

function parseNumber(key: string): number | null {
  return /^[1-9]\d{0,9}$/.test(key) ? Number(key) : null;
}

/** WIQL string literals are single-quoted and escape a quote by doubling it. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function involvementClause(involvement: IssueInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    // Azure records no mention of a person on a work item, so a mention filter has nothing to narrow by.
    case "mentioned":
    case "all":
      return "";
  }
}

/** `<iso changed date>|<id>` of the last row handed over, which is where the next page starts. */
function parseCursor(cursor: string): { readonly changedAt: string; readonly id: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([1-9]\d{0,9})$/.exec(cursor);
  return match === null ? null : { changedAt: match[1]!, id: Number(match[2]) };
}

function reasonFor(error: AzureDevOpsCli.AzureDevOpsCliError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "AzureDevOpsCliUnavailableError":
      return "missing-tool";
    case "AzureDevOpsCliAuthenticationError":
      return "unauthenticated";
    case "AzureDevOpsCliRateLimitError":
      return "rate-limited";
    case "AzureDevOpsPullRequestNotFoundError":
      return "not-found";
    default:
      return "failed";
  }
}

export const make: Effect.Effect<
  IssueTrackerApi,
  never,
  AzureDevOpsCli.AzureDevOpsCli | FileSystem.FileSystem
> = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fs = yield* FileSystem.FileSystem;

  const fail = (operation: string) => (error: AzureDevOpsCli.AzureDevOpsCliError) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: reasonFor(error),
      detail: error.message,
      cause: error,
    });

  const refused = (operation: string, detail: string, cause?: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const unreadable = (operation: string, cause: unknown) =>
    refused(operation, `Azure DevOps returned an unreadable ${operation} response.`, cause);

  const notFound = (operation: string) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "not-found",
      detail: "Azure DevOps could not find the requested work item.",
    });

  const scoped = (
    operation: string,
    input: { readonly host: string; readonly scope: string },
  ): Effect.Effect<
    { readonly organization: string; readonly project: string },
    IssueTrackerError
  > => {
    const parsed = parseScope(input.host, input.scope);
    return parsed === null
      ? Effect.fail(refused(operation, "An Azure DevOps scope is named `organization/project`."))
      : Effect.succeed(parsed);
  };

  const run = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    azure
      .execute({ cwd: input.cwd, args: [...input.args, "--only-show-errors", "--output", "json"] })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(fail(input.operation)),
      );

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, IssueTrackerError> =>
    run(input).pipe(
      Effect.flatMap((raw) => {
        const decoded = input.decode(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(unreadable(input.operation, decoded.failure));
      }),
    );

  const decodeAs =
    <A>(schema: (value: unknown) => Result.Result<A, unknown>) =>
    (raw: string): Result.Result<A, unknown> =>
      Result.flatMap(decodeUnknown(raw), schema);

  /** A `wit` REST route, addressed by resource and route parameters rather than by URL. */
  const invokeArgs = (input: {
    readonly organization: string;
    readonly project: string;
    readonly resource: string;
    readonly route?: ReadonlyArray<string>;
    readonly query?: ReadonlyArray<string>;
    readonly method?: string;
    readonly apiVersion?: string;
  }) => [
    "devops",
    "invoke",
    "--detect",
    "false",
    "--organization",
    input.organization,
    "--area",
    "wit",
    "--resource",
    input.resource,
    "--api-version",
    input.apiVersion ?? REST_API_VERSION,
    "--route-parameters",
    `project=${input.project}`,
    ...(input.route ?? []),
    ...(input.query === undefined || input.query.length === 0
      ? []
      : ["--query-parameters", ...input.query]),
    ...(input.method === undefined ? [] : ["--http-method", input.method]),
  ];

  /** A request with a body, which `az devops invoke` only takes from a file. */
  const invokeWithBody = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly body: unknown;
    readonly mediaType?: string;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs
          .makeTempFileScoped({ prefix: "t3-azure-issue-" })
          .pipe(Effect.mapError((cause) => refused(input.operation, cause.message, cause)));
        yield* fs
          .writeFileString(file, encodeJson(input.body))
          .pipe(Effect.mapError((cause) => refused(input.operation, cause.message, cause)));
        return yield* run({
          cwd: input.cwd,
          operation: input.operation,
          args: [
            ...input.args,
            "--in-file",
            file,
            "--media-type",
            input.mediaType ?? "application/json",
          ],
        });
      }),
    );

  const workItem = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly project: string;
    readonly number: number;
  }): Effect.Effect<AzureDevOpsWorkItem, IssueTrackerError> =>
    read({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "boards",
        "work-item",
        "show",
        "--detect",
        "false",
        "--organization",
        input.organization,
        "--id",
        String(input.number),
        "--expand",
        "relations",
      ],
      decode: decodeWorkItemJson,
    }).pipe(
      Effect.filterOrFail(
        (item) => item !== null,
        () => notFound(input.operation),
      ),
      Effect.flatMap((item) => {
        if (item.project?.toLowerCase() === input.project.toLowerCase())
          return Effect.succeed(item);
        if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(input.project))
          return Effect.fail(notFound(input.operation));
        return read({
          cwd: input.cwd,
          operation: input.operation,
          args: [
            "devops",
            "project",
            "show",
            "--organization",
            input.organization,
            "--project",
            input.project,
          ],
          decode: decodeAs(
            Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String, name: Schema.String })),
          ),
        }).pipe(
          Effect.filterOrFail(
            (project) =>
              project.id.toLowerCase() === input.project.toLowerCase() &&
              project.name.toLowerCase() === item.project?.toLowerCase(),
            () => notFound(input.operation),
          ),
          Effect.as(item),
        );
      }),
    );

  /** The work item as `az` addresses it, or a not-found for a key that names no id. */
  const target = (
    operation: string,
    input: {
      readonly cwd: string;
      readonly host: string;
      readonly scope: string;
      readonly key: string;
    },
  ) =>
    scoped(operation, input).pipe(
      Effect.flatMap((scope) => {
        const number = parseNumber(input.key);
        return number === null
          ? Effect.fail(notFound(operation))
          : workItem({ ...scope, number, cwd: input.cwd, operation }).pipe(
              Effect.map((item) => ({ ...scope, number, item })),
            );
      }),
    );

  const comments = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly project: string;
    readonly number: number;
    readonly cursor?: string | undefined;
    readonly viewer?: string;
  }) =>
    read({
      cwd: input.cwd,
      operation: input.operation,
      args: invokeArgs({
        ...input,
        resource: "comments",
        route: [`workItemId=${input.number}`],
        apiVersion: "7.1-preview",
        query: [
          `$top=${PAGE_SIZE}`,
          "order=asc",
          "$expand=reactions",
          "api-version=7.1-preview.4",
          ...(input.cursor === undefined ? [] : [`continuationToken=${input.cursor}`]),
        ],
      }),
      decode: (raw) => decodeCommentsJson(raw, input.viewer),
    });

  const linkedPullRequests = (input: {
    readonly cwd: string;
    readonly organization: string;
    readonly item: AzureDevOpsWorkItem;
  }): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
    const numbers = [
      ...new Set(input.item.relations.flatMap((relation) => pullRequestNumberOf(relation) ?? [])),
    ].slice(0, LINKED_PULL_REQUEST_LIMIT);
    return Effect.forEach(
      numbers,
      (number) =>
        read({
          cwd: input.cwd,
          operation: "getIssue",
          args: [
            "repos",
            "pr",
            "show",
            "--detect",
            "false",
            "--organization",
            input.organization,
            "--id",
            String(number),
          ],
          decode: decodePullRequestJson,
        }).pipe(
          Effect.map((pullRequest) =>
            pullRequest === null || pullRequest.location === null
              ? []
              : [
                  {
                    repository: `${pullRequest.location.project}/${pullRequest.location.repository}`,
                    number: pullRequest.number,
                    title: pullRequest.title,
                    url: pullRequest.url,
                    state: pullRequest.state,
                    isDraft: pullRequest.isDraft,
                    // Azure links a pull request to a work item but never says whether completing
                    // it resolves the item; that lives in a completion option nothing reports.
                    closesIssue: false,
                  },
                ],
          ),
          // A link to a pull request this account cannot see is left out, not a failed detail.
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed([]),
          ),
        ),
      { concurrency: 2 },
    ).pipe(Effect.map((links) => links.flat()));
  };

  const update = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly number: number;
    readonly args: ReadonlyArray<string>;
  }) =>
    run({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "boards",
        "work-item",
        "update",
        "--detect",
        "false",
        "--organization",
        input.organization,
        "--id",
        String(input.number),
        ...input.args,
      ],
    }).pipe(Effect.asVoid);

  /** Azure keeps tags as one `; `-joined field and takes exactly one assignee. */
  const fieldArgs = (input: {
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  }): ReadonlyArray<string> => {
    const fields = [
      ...(input.labels === undefined ? [] : [`System.Tags=${input.labels.join("; ")}`]),
      ...(input.assignees === undefined ? [] : [`System.AssignedTo=${input.assignees[0] ?? ""}`]),
    ];
    return fields.length === 0 ? [] : ["--fields", ...fields];
  };

  const pageOffset = (input: IssuePageInput, operation: string) => {
    const value =
      input.cursor === undefined ? 0 : /^\d{1,9}$/.test(input.cursor) ? Number(input.cursor) : null;
    return value === null
      ? Effect.fail(refused(operation, "The cursor was not one Azure DevOps handed out."))
      : Effect.succeed(value);
  };

  const workflows = (
    input: { readonly cwd: string; readonly organization: string; readonly project: string },
    type: string,
  ) =>
    read({
      cwd: input.cwd,
      operation: "getStates",
      args: invokeArgs({
        ...input,
        resource: "workitemtypestates",
        route: [`type=${type}`],
        apiVersion: "7.1-preview.1",
      }),
      decode: decodeAs(
        Schema.decodeUnknownResult(
          Schema.Struct({
            value: Schema.Array(Schema.Struct({ name: Schema.String, category: Schema.String })),
          }),
        ),
      ),
    }).pipe(Effect.flatMap((page) => nativeStates(page.value)));

  const nativeStates = (
    rows: ReadonlyArray<{ readonly name: string; readonly category: string }>,
  ) =>
    Effect.forEach(rows, (state): Effect.Effect<IssueState, IssueTrackerError> => {
      const workflowCategory = WORKFLOW_CATEGORY[state.category];
      return workflowCategory === undefined
        ? Effect.fail(refused("getStates", "Azure returned an unknown workflow category."))
        : Effect.succeed({
            name: state.name,
            id: state.name,
            category:
              workflowCategory === "completed" || workflowCategory === "canceled"
                ? "closed"
                : "open",
            workflowCategory,
          });
    });

  const workItemTypes = (input: {
    readonly cwd: string;
    readonly organization: string;
    readonly project: string;
  }) =>
    read({
      cwd: input.cwd,
      operation: "getStates",
      args: [
        ...invokeArgs({ ...input, resource: "workitemtypes" }),
        "--query",
        "{value: value[].{name: name, isDisabled: isDisabled, states: states[].{name: name, category: category}}}",
      ],
      decode: decodeAs(decodeTypes),
    });

  const itemWorkflow = (
    input: { readonly cwd: string; readonly organization: string; readonly project: string },
    item: AzureDevOpsWorkItem,
  ): Effect.Effect<
    { readonly item: AzureDevOpsWorkItem; readonly states: ReadonlyArray<IssueState> },
    IssueTrackerError
  > =>
    item.workItemType === null
      ? Effect.succeed({ item, states: CAPABILITIES.states })
      : workflows(input, item.workItemType).pipe(
          Effect.flatMap((states) => {
            const state = states.find((state) => state.name === item.state.name);
            return state === undefined
              ? Effect.fail(
                  refused("getStates", "The work item state is absent from its workflow."),
                )
              : Effect.succeed({ item: { ...item, state }, states });
          }),
        );

  const itemsWorkflow = (
    input: { readonly cwd: string; readonly organization: string; readonly project: string },
    items: ReadonlyArray<AzureDevOpsWorkItem>,
    knownTypes?: typeof WorkItemTypes.Type,
  ) =>
    Effect.gen(function* () {
      const groups = [
        ...new Set(
          items.flatMap((item) =>
            item.workItemType === null ? [] : [item.project ?? input.project],
          ),
        ),
      ];
      const states = new Map(
        yield* Effect.forEach(
          groups,
          (project) =>
            Effect.gen(function* () {
              const types = knownTypes ?? (yield* workItemTypes({ ...input, project }));
              return yield* Effect.forEach(
                types.value.filter((type) =>
                  items.some(
                    (item) =>
                      item.workItemType === type.name &&
                      (item.project ?? input.project) === project,
                  ),
                ),
                (type) =>
                  nativeStates(type.states ?? []).pipe(
                    Effect.map((states) => [`${project}\0${type.name}`, states] as const),
                  ),
              );
            }),
          { concurrency: 3 },
        ).pipe(Effect.map((groups) => groups.flat())),
      );
      return yield* Effect.forEach(items, (item) => {
        if (item.workItemType === null) return Effect.succeed(item);
        const state = states
          .get(`${item.project}\0${item.workItemType}`)
          ?.find((state) => state.name === item.state.name);
        return state === undefined
          ? Effect.fail(refused("getStates", "The work item state is absent from its workflow."))
          : Effect.succeed({ ...item, state });
      });
    });

  const defaultTeam = (input: IssueScopeTarget) =>
    scoped("defaultTeam", input).pipe(
      Effect.flatMap((scope) =>
        read({
          cwd: input.cwd,
          operation: "defaultTeam",
          args: [
            "devops",
            "project",
            "show",
            "--detect",
            "false",
            "--organization",
            scope.organization,
            "--project",
            scope.project,
          ],
          decode: decodeAs(
            Schema.decodeUnknownResult(
              Schema.Struct({
                id: Schema.String,
                name: Schema.String,
                defaultTeam: Schema.Struct({ id: Schema.String }),
              }),
            ),
          ),
        }).pipe(Effect.map((project) => ({ ...scope, ...project }))),
      ),
    );

  const template = (
    input: IssueScopeTarget,
    key: string,
    project: {
      readonly organization: string;
      readonly id: string;
      readonly defaultTeam: { readonly id: string };
    },
  ) =>
    read({
      cwd: input.cwd,
      operation: "listTemplates",
      args: invokeArgs({
        organization: project.organization,
        project: project.id,
        resource: "templates",
        route: [`team=${project.defaultTeam.id}`, `templateId=${key}`],
        apiVersion: "7.1-preview.1",
      }),
      decode: decodeAs(Schema.decodeUnknownResult(WorkItemTemplate)),
    });

  const setParent: NonNullable<IssueTrackerApi["setParent"]> = (input) =>
    Effect.gen(function* () {
      if (input.parentKey === input.key)
        return yield* refused("setParent", "An issue cannot be its own parent.");
      const scope = yield* target("setParent", input);
      const parent =
        input.parentKey === null
          ? null
          : yield* target("setParent", { ...input, key: input.parentKey });
      if (scope.item.revision === null || (parent !== null && parent.item.nativeUrl === null))
        return yield* refused("setParent", "Azure returned no work item revision or URL.");
      const removal = scope.item.relations
        .flatMap((relation, index) =>
          relation.rel === "System.LinkTypes.Hierarchy-Reverse" ? [index] : [],
        )
        .toReversed()
        .map((index) => ({ op: "remove", path: `/relations/${index}` }));
      yield* invokeWithBody({
        cwd: input.cwd,
        operation: "setParent",
        args: invokeArgs({
          ...scope,
          resource: "workitems",
          route: [`id=${scope.number}`],
          method: "PATCH",
          query: ["$expand=Relations"],
        }),
        mediaType: "application/json-patch+json",
        body: [
          { op: "test", path: "/rev", value: scope.item.revision },
          ...removal,
          ...(parent === null
            ? []
            : [
                {
                  op: "add",
                  path: "/relations/-",
                  value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: parent.item.nativeUrl },
                },
              ]),
        ],
      });
    });

  const labelCandidates: NonNullable<IssueTrackerApi["listLabelCandidates"]> = (input) =>
    Effect.gen(function* () {
      const skip = yield* pageOffset(input, "listLabelCandidates");
      const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
      const scope = yield* scoped("listLabelCandidates", input);
      const tags = yield* read({
        cwd: input.cwd,
        operation: "listLabelCandidates",
        args: invokeArgs({ ...scope, resource: "tags" }),
        decode: decodeAs(decodeTags),
      });
      return {
        items: tags.value
          .slice(skip, skip + limit)
          .map((tag) => ({ name: tag.name, color: null, description: null })),
        nextCursor: skip + limit < tags.value.length ? String(skip + limit) : null,
      };
    });

  const assigneeCandidates: NonNullable<IssueTrackerApi["listAssigneeCandidates"]> = (input) =>
    Effect.gen(function* () {
      const skip = yield* pageOffset(input, "listAssigneeCandidates");
      const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
      const project = yield* defaultTeam(input);
      const rows = yield* read({
        cwd: input.cwd,
        operation: "listAssigneeCandidates",
        args: [
          "devops",
          "team",
          "list-member",
          "--detect",
          "false",
          "--organization",
          project.organization,
          "--project",
          project.id,
          "--team",
          project.defaultTeam.id,
          "--top",
          String(limit),
          "--skip",
          String(skip),
        ],
        decode: decodeAs(decodeMembers),
      });
      return {
        items: rows.flatMap(({ identity }) =>
          identity.isContainer || !identity.uniqueName.trim()
            ? []
            : [
                {
                  id: identity.uniqueName,
                  login: identity.uniqueName,
                  name: identity.displayName ?? null,
                  avatarUrl: identity.imageUrl ?? null,
                },
              ],
        ),
        nextCursor: rows.length >= limit ? String(skip + rows.length) : null,
      };
    });

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    // The profile the token belongs to, which is what WIQL's `@Me` resolves to. Its email is the
    // `uniqueName` every identity on a work item carries, so the two compare.
    getViewer: (input) =>
      read({
        cwd: input.cwd,
        operation: "getViewer",
        args: [
          "devops",
          "invoke",
          "--detect",
          "true",
          "--area",
          "profile",
          "--resource",
          "profiles",
          "--api-version",
          REST_API_VERSION,
          "--route-parameters",
          "id=me",
        ],
        decode: decodeProfileJson,
      }).pipe(
        Effect.filterOrFail(
          (login) => login !== null,
          () => refused("getViewer", "Azure DevOps could not name the signed-in account."),
        ),
      ),

    listIssues: (input) =>
      Effect.gen(function* () {
        if (input.involvement === "mentioned")
          return yield* refused("listIssues", "Azure DevOps does not support a mentioned filter.");
        const sort = input.sort ?? "updated";
        const order = input.order ?? "desc";
        const limit = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
        const field =
          sort === "created"
            ? "System.CreatedDate"
            : sort === "comments"
              ? "System.CommentCount"
              : "System.ChangedDate";
        const requestedScope = yield* scoped("listIssues", input);
        const scope = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(requestedScope.project)
          ? { ...requestedScope, project: (yield* defaultTeam(input)).name }
          : requestedScope;
        const clauses = [`[System.TeamProject] = ${quoted(scope.project)}`];
        const categories =
          input.stateCategories ??
          (input.state === "all"
            ? undefined
            : input.state === "closed"
              ? ["completed", "canceled"]
              : ["backlog", "unstarted", "started"]);
        let types: typeof WorkItemTypes.Type | undefined;
        if (categories !== undefined) {
          if (categories.every((category) => category === "backlog"))
            return { items: [], nextCursor: null };
          types = yield* workItemTypes({ ...scope, cwd: input.cwd });
          const enabled = types.value.filter((type) => !type.isDisabled);
          if (enabled.some((type) => type.states === undefined || type.states === null))
            return yield* refused(
              "listIssues",
              "Azure returned no workflow states for a work item type.",
            );
          const groups = yield* Effect.forEach(enabled, (type) =>
            nativeStates(type.states ?? []).pipe(
              Effect.map((states) => ({
                type: type.name,
                states: states.filter(
                  (state) =>
                    state.workflowCategory !== undefined &&
                    categories.includes(state.workflowCategory),
                ),
              })),
            ),
          );
          const filters = groups.flatMap((group) =>
            group.states.length === 0
              ? []
              : [
                  `([System.WorkItemType] = ${quoted(group.type)} AND [System.State] IN (${group.states.map((state) => quoted(state.name)).join(",")}))`,
                ],
          );
          if (filters.length === 0) return { items: [], nextCursor: null };
          clauses.push(`(${filters.join(" OR ")})`);
        }
        const text = input.query?.trim() ?? "";
        if (text) clauses.push(`[System.Title] CONTAINS ${quoted(text)}`);
        const involvement = involvementClause(input.involvement);
        if (involvement) clauses.push(involvement.replace(/^ AND /, ""));
        if (input.cursor !== undefined) {
          const native = decodeAs(decodeListCursor)(input.cursor);
          const old = parseCursor(input.cursor);
          const cursor = Result.isSuccess(native)
            ? native.success
            : old !== null && sort === "updated" && order === "desc"
              ? { sort, order, value: old.changedAt, id: old.id }
              : null;
          if (
            cursor === null ||
            cursor.sort !== sort ||
            cursor.order !== order ||
            (sort === "comments"
              ? typeof cursor.value !== "number"
              : typeof cursor.value !== "string" ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(cursor.value))
          )
            return yield* refused("listIssues", "The cursor was not one Azure DevOps handed out.");
          const comparison = order === "asc" ? ">" : "<";
          const value =
            typeof cursor.value === "number" ? String(cursor.value) : quoted(cursor.value);
          clauses.push(
            `([${field}] ${comparison} ${value} OR ([${field}] = ${value} AND [System.Id] ${comparison} ${cursor.id}))`,
          );
        }
        const raw = yield* invokeWithBody({
          cwd: input.cwd,
          operation: "listIssues",
          args: invokeArgs({
            ...scope,
            resource: "wiql",
            method: "POST",
            query: ["timePrecision=true", `$top=${limit + 1}`],
          }),
          body: {
            query: `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [${field}] ${order.toUpperCase()}, [System.Id] ${order.toUpperCase()}`,
          },
        });
        const refs = decodeAs(decodeWiql)(raw);
        if (!Result.isSuccess(refs)) return yield* unreadable("listIssues", raw);
        const ids = refs.success.workItems ?? [];
        if (ids.length === 0) return { items: [], nextCursor: null };
        const rows = yield* read({
          cwd: input.cwd,
          operation: "listIssues",
          args: invokeArgs({
            ...scope,
            resource: "workitems",
            query: [
              `ids=${ids
                .slice(0, limit)
                .map((row) => row.id)
                .join(",")}`,
              `fields=${LIST_FIELDS.join(",")}`,
              ...(refs.success.asOf === undefined ? [] : [`asOf=${refs.success.asOf}`]),
            ],
          }),
          decode: decodeWorkItemsJson,
        });
        const indexed = new Map(rows.map((row) => [row.key, row]));
        const ordered = ids.slice(0, limit).flatMap(({ id }) => indexed.get(String(id)) ?? []);
        if (
          ordered.length !== Math.min(ids.length, limit) ||
          ordered.some((row) => row.project?.toLowerCase() !== scope.project.toLowerCase())
        )
          return yield* refused(
            "listIssues",
            "Azure returned an incomplete or foreign work item page.",
          );
        if (types === undefined && ordered.some((item) => item.workItemType !== null))
          types = yield* workItemTypes({ ...scope, cwd: input.cwd });
        const items = yield* itemsWorkflow({ ...scope, cwd: input.cwd }, ordered, types);
        const last = items.at(-1)!;
        const value =
          sort === "created"
            ? last.createdAt
            : sort === "comments"
              ? (last.commentCount ?? 0)
              : last.updatedAt;
        return {
          items,
          nextCursor:
            ids.length > limit
              ? sort === "updated" && order === "desc"
                ? `${value}|${last.key}`
                : encodeJson({ sort, order, value, id: Number(last.key) })
              : null,
        };
      }),

    getIssue: (input) =>
      target("getIssue", input).pipe(
        Effect.flatMap((scope) =>
          Effect.all(
            [
              comments({
                ...scope,
                cwd: input.cwd,
                operation: "getIssue",
                ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
              }),
              read({
                cwd: input.cwd,
                operation: "getIssue",
                args: invokeArgs({
                  ...scope,
                  resource: "updates",
                  route: [`id=${scope.number}`],
                  query: [`$top=${PAGE_SIZE}`],
                }),
                decode: decodeUpdatesJson,
              }),
              itemWorkflow({ ...scope, cwd: input.cwd }, scope.item),
              linkedPullRequests({
                cwd: input.cwd,
                organization: scope.organization,
                item: scope.item,
              }),
            ],
            { concurrency: 3 },
          ).pipe(
            Effect.map(([conversation, updates, workflow, links]) => ({
              ...workflow.item,
              states: workflow.states,
              // Nothing cheap names the viewer here; the service already read it per host.
              viewer: input.viewer ?? null,
              viewerPermissions: VIEWER_PERMISSIONS,
              comments: conversation.comments,
              commentsCursor: conversation.nextCursor,
              events: updates.events,
              historyTruncated: updates.rawCount >= PAGE_SIZE,
              linkedPullRequests: links,
            })),
          ),
        ),
      ),

    getComments: (input) =>
      target("getComments", input).pipe(
        Effect.flatMap((scope) =>
          comments({
            ...scope,
            cwd: input.cwd,
            operation: "getComments",
            cursor: input.cursor,
            ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
          }),
        ),
      ),

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    setParent,
    listLabelCandidates: labelCandidates,
    listAssigneeCandidates: assigneeCandidates,

    editComment: (input) =>
      Effect.gen(function* () {
        if (parseNumber(input.commentId) === null)
          return yield* refused("editComment", "The comment id names no Azure DevOps comment.");
        const scope = yield* target("editComment", input);
        const route = [`workItemId=${scope.number}`, `commentId=${input.commentId}`];
        yield* invokeWithBody({
          cwd: input.cwd,
          operation: "editComment",
          args: invokeArgs({
            ...scope,
            resource: "comments",
            route,
            method: "PATCH",
            apiVersion: "7.1-preview.4",
            query: ["format=markdown"],
          }),
          body: { text: input.body },
        });
      }),

    getHistory: (input) =>
      Effect.gen(function* () {
        const scope = yield* target("getHistory", input);
        const skip = yield* pageOffset(input, "getHistory");
        const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
        const page = yield* read({
          cwd: input.cwd,
          operation: "getHistory",
          args: invokeArgs({
            ...scope,
            resource: "updates",
            route: [`id=${scope.number}`],
            query: [`$top=${limit}`, `$skip=${skip}`],
          }),
          decode: decodeUpdatesJson,
        });
        return {
          items: page.events,
          nextCursor: page.rawCount >= limit ? String(skip + page.rawCount) : null,
        };
      }),

    getLinkedPullRequests: (input) =>
      Effect.gen(function* () {
        const scope = yield* target("getLinkedPullRequests", input);
        const skip = yield* pageOffset(input, "getLinkedPullRequests");
        const limit = Math.min(input.limit ?? LINKED_PULL_REQUEST_LIMIT, LINKED_PULL_REQUEST_LIMIT);
        const artifacts = [
          ...new Map(
            scope.item.relations.flatMap((relation) =>
              pullRequestNumberOf(relation) === null ? [] : [[relation.url, relation] as const],
            ),
          ).values(),
        ];
        const item = { ...scope.item, relations: artifacts.slice(skip, skip + limit) };
        return {
          items: yield* linkedPullRequests({
            cwd: input.cwd,
            organization: scope.organization,
            item,
          }),
          nextCursor: skip + limit < artifacts.length ? String(skip + limit) : null,
        };
      }),

    getHierarchy: (input) =>
      Effect.gen(function* () {
        const scope = yield* target("getHierarchy", input);
        const skip = yield* pageOffset(input, "getHierarchy");
        const limit = Math.min(input.limit ?? LINKED_PULL_REQUEST_LIMIT, LINKED_PULL_REQUEST_LIMIT);
        const parent = scope.item.relations.find(
          (relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse",
        );
        const children = scope.item.relations.filter(
          (relation) => relation.rel === "System.LinkTypes.Hierarchy-Forward",
        );
        const selected = [
          ...(parent === undefined ? [] : [parent]),
          ...children.slice(skip, skip + limit),
        ];
        const numbers = selected.map((relation) => {
          const url = URL.parse(relation.url);
          const organization = new URL(scope.organization);
          const match = /\/_apis\/wit\/workitems\/([1-9]\d*)$/i.exec(url?.pathname ?? "");
          return url !== null &&
            url.origin === organization.origin &&
            url.pathname.toLowerCase().startsWith(`${organization.pathname.toLowerCase()}/`) &&
            match
            ? Number(match[1])
            : null;
        });
        if (numbers.some((number) => number === null))
          return yield* refused(
            "getHierarchy",
            "Azure returned a hierarchy link outside this organization.",
          );
        if (numbers.length === 0)
          return { parent: null, children: { items: [], nextCursor: null } };
        const items = yield* read({
          cwd: input.cwd,
          operation: "getHierarchy",
          args: invokeArgs({
            ...scope,
            project: "",
            resource: "workitems",
            query: [`ids=${numbers.join(",")}`],
          }),
          decode: decodeWorkItemsJson,
        });
        const native = yield* itemsWorkflow({ ...scope, cwd: input.cwd }, items);
        const related = native.map((item): IssueRelation => ({
          scope: `${input.scope.split("/")[0]}/${item.project}`,
          key: item.key,
          displayKey: item.displayKey,
          title: item.title,
          url: item.url,
          state: item.state,
        }));
        const indexed = new Map(related.map((item) => [Number(item.key), item]));
        if (numbers.some((number) => !indexed.has(number!)))
          return yield* refused("getHierarchy", "Azure returned an incomplete hierarchy page.");
        return {
          parent: parent === undefined ? null : indexed.get(numbers[0]!)!,
          children: {
            items: numbers
              .slice(parent === undefined ? 0 : 1)
              .map((number) => indexed.get(number!)!),
            nextCursor: skip + limit < children.length ? String(skip + limit) : null,
          },
        };
      }),

    listTemplates: (input) =>
      Effect.gen(function* () {
        const project = yield* defaultTeam(input);
        const refs = yield* read({
          cwd: input.cwd,
          operation: "listTemplates",
          args: invokeArgs({
            organization: project.organization,
            project: project.id,
            resource: "templates",
            route: [`team=${project.defaultTeam.id}`],
            apiVersion: "7.1-preview.1",
          }),
          decode: decodeAs(
            Schema.decodeUnknownResult(
              Schema.Struct({ value: Schema.Array(Schema.Struct({ id: Schema.String })) }),
            ),
          ),
        });
        if (refs.value.length > 100)
          return yield* refused(
            "listTemplates",
            "Azure returned more templates than this client supports.",
          );
        const rows = yield* Effect.forEach(refs.value, (ref) => template(input, ref.id, project), {
          concurrency: 3,
        });
        return {
          templates: rows.map((row) => ({
            key: row.id,
            name: row.name,
            about: row.description ?? "",
            title: row.fields["System.Title"] ?? "",
            body: row.fields["System.Description"] ?? "",
            labels: (row.fields["System.Tags"] ?? "")
              .split(";")
              .map((tag) => tag.trim())
              .filter(Boolean),
            assignees: row.fields["System.AssignedTo"] ? [row.fields["System.AssignedTo"]] : [],
          })),
          blankIssuesEnabled: true,
        };
      }),

    create: (input) =>
      Effect.gen(function* () {
        const scope = yield* scoped("create", input);
        const selected =
          input.templateKey === undefined
            ? undefined
            : yield* template(input, input.templateKey, yield* defaultTeam(input));
        const types = yield* read({
          cwd: input.cwd,
          operation: "create",
          args: invokeArgs({ ...scope, resource: "workitemtypes" }),
          decode: decodeAs(decodeTypes),
        });
        const names = types.value.flatMap((type) => (type.isDisabled ? [] : [type.name]));
        const type =
          input.issueType ??
          selected?.workItemTypeName ??
          CREATE_TYPES.find((name) => names.includes(name)) ??
          names[0];
        if (type === undefined || !names.includes(type))
          return yield* refused("create", "The project offers no such work item type to file.");
        const parent =
          input.parentKey === undefined
            ? undefined
            : yield* target("create", { ...input, key: input.parentKey });
        if (parent !== undefined && parent.item.nativeUrl === null)
          return yield* refused("create", "Azure returned no parent work item URL.");
        const fields = {
          ...selected?.fields,
          "System.Title": input.title,
          "System.Description": input.body,
          ...(input.labels.length === 0 ? {} : { "System.Tags": input.labels.join("; ") }),
          ...(input.assignees.length === 0 ? {} : { "System.AssignedTo": input.assignees[0]! }),
        };
        const raw = yield* invokeWithBody({
          cwd: input.cwd,
          operation: "create",
          args: invokeArgs({
            ...scope,
            resource: "workitems",
            route: [`type=${type}`, `id=$${type}`],
            method: "POST",
            query: ["$expand=Relations"],
          }),
          mediaType: "application/json-patch+json",
          body: [
            ...Object.entries(fields).map(([field, value]) => ({
              op: "add",
              path: `/fields/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`,
              value,
            })),
            { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
            ...(parent === undefined
              ? []
              : [
                  {
                    op: "add",
                    path: "/relations/-",
                    value: {
                      rel: "System.LinkTypes.Hierarchy-Reverse",
                      url: parent.item.nativeUrl,
                    },
                  },
                ]),
          ],
        });
        const decoded = decodeWorkItemJson(raw);
        if (!Result.isSuccess(decoded) || decoded.success === null)
          return yield* unreadable("create", raw);
        const item = decoded.success;
        return {
          key: item.key,
          displayKey: item.displayKey,
          url: item.url,
          ...(parent === undefined ? {} : { parentLinked: true }),
        };
      }),

    comment: (input) =>
      target("comment", input).pipe(
        Effect.flatMap((scope) =>
          invokeWithBody({
            cwd: input.cwd,
            operation: "comment",
            args: invokeArgs({
              ...scope,
              resource: "comments",
              route: [`workItemId=${scope.number}`],
              method: "POST",
              apiVersion: "7.1-preview",
              query: ["format=markdown", "api-version=7.1-preview.4"],
            }),
            body: { text: input.body },
          }),
        ),
        Effect.asVoid,
      ),

    update: (input) =>
      target("update", input).pipe(
        Effect.flatMap((scope) =>
          update({
            ...scope,
            cwd: input.cwd,
            operation: "update",
            args: [
              ...(input.title === undefined ? [] : ["--title", input.title]),
              ...(input.body === undefined ? [] : ["--description", input.body]),
              ...fieldArgs(input),
            ],
          }),
        ),
      ),

    setState: (input) =>
      target("setState", input).pipe(
        Effect.flatMap((scope) =>
          update({
            ...scope,
            cwd: input.cwd,
            operation: "setState",
            args: ["--state", input.state],
          }),
        ),
      ),

    setReaction: (input) =>
      target("setReaction", input).pipe(
        Effect.flatMap((scope) => {
          const type = azureDevOpsReactionType(input.content);
          if (input.subjectId === undefined) {
            return Effect.fail(
              refused("setReaction", "Azure DevOps reactions go on comments only."),
            );
          }
          if (!/^[1-9]\d{0,9}$/.test(input.subjectId)) {
            return Effect.fail(
              refused("setReaction", "The comment id names no Azure DevOps comment."),
            );
          }
          if (type === null) {
            return Effect.fail(refused("setReaction", "Azure DevOps has no such reaction."));
          }
          return run({
            cwd: input.cwd,
            operation: "setReaction",
            args: invokeArgs({
              ...scope,
              resource: "commentsReactions",
              route: [
                `workItemId=${scope.number}`,
                `commentId=${input.subjectId}`,
                `reactionType=${type}`,
              ],
              method: input.reacted ? "PUT" : "DELETE",
              apiVersion: "7.1-preview",
              query: ["api-version=7.1-preview.1"],
            }),
          }).pipe(Effect.asVoid);
        }),
      ),

    listCandidates: (input) =>
      Effect.gen(function* () {
        const [labels, assignees, scope] = yield* Effect.all(
          [labelCandidates(input), assigneeCandidates(input), scoped("listCandidates", input)],
          { concurrency: 3 },
        );
        const types = yield* workItemTypes({ ...scope, cwd: input.cwd });
        const enabled = types.value.filter((type) => !type.isDisabled).slice(0, 100);
        const native = yield* Effect.forEach(enabled, (type) => nativeStates(type.states ?? []));
        const states = [...new Map(native.flat().map((state) => [state.name, state])).values()];
        return {
          labels: labels.items.map((label) => ({
            ...label,
            description: label.description ?? null,
          })),
          assignees: assignees.items.map((actor) => ({ ...actor, id: actor.id ?? actor.login })),
          states,
          issueTypes: enabled.map((type) => ({ id: type.name, name: type.name })),
          truncated:
            labels.nextCursor !== null ||
            assignees.nextCursor !== null ||
            types.value.length > 100 ||
            enabled.some((type) => type.states === undefined || type.states === null),
        };
      }),
  };
});
