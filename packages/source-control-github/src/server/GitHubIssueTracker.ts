/**
 * GitHub's issue tracker, over the same `GitHubApi` the pull request reads use: one credential,
 * one quota reserve, one rate-limit pause per host.
 *
 * Reads go through GraphQL, which is the only API that answers the viewer's standing, the
 * timeline and reactions. Writes to the issue's own fields go through REST `PATCH`, which takes
 * the whole label and assignee sets in one call, the way the port asks for them.
 *
 * @module source-control-github/server/GitHubIssueTracker
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  SourceControlProviderKind,
  IssueEventKind,
  type IssueEvent,
  type IssueRelation,
  type IssuePageInput,
  type IssueLinkedPullRequest,
  type IssueCapabilities,
  type IssueInvolvement,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueScopeTarget,
  type IssueTarget,
} from "@t3tools/issue-tracker-core/server/IssueTracker";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { readGitHubIssueTemplateFiles } from "./gitHubIssueTemplates.ts";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import * as GitHubApi from "./GitHubApi.ts";
import {
  ADD_REACTION_GRAPHQL_MUTATION,
  gitHubReactionContent,
  REMOVE_REACTION_GRAPHQL_MUTATION,
} from "./gitHubPullRequestJson.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueCandidatesJson,
  decodeIssueCommentScopeJson,
  decodeIssueCommentsJson,
  decodeIssueDetailJson,
  decodeRestIssueLabelsJson,
  decodeRestIssueMetadataJson,
  decodeIssueNodeIdJson,
  decodeIssueSearchJson,
  decodeIssueTemplatesJson,
  decodeIssueTemplateFilesJson,
  decodeIssueEditableCommentScopeJson,
  decodeIssueViewerPermissionsJson,
  decodeViewerLoginJson,
  ISSUE_CANDIDATES_GRAPHQL_QUERY,
  ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
  ISSUE_COMMENTS_GRAPHQL_QUERY,
  ISSUE_DETAIL_GRAPHQL_QUERY,
  ISSUE_NODE_ID_GRAPHQL_QUERY,
  ISSUE_TEMPLATES_GRAPHQL_QUERY,
  ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  issueSearchGraphQlQuery,
  SEARCH_MAX_ROWS,
} from "./gitHubIssueJson.ts";

const RelatedIssue = Schema.Struct({
  id: Schema.Int,
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
});
const CandidateActor = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const CandidateLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
});
const HistoryEvent = Schema.Struct({
  id: Schema.optional(Schema.Int),
  node_id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  actor: Schema.optional(Schema.NullOr(CandidateActor)),
  label: Schema.optional(Schema.Struct({ name: Schema.String })),
  assignee: Schema.optional(CandidateActor),
  rename: Schema.optional(Schema.Struct({ from: Schema.String, to: Schema.String })),
});
const LinkedRequest = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Int),
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
  repository: Schema.optional(Schema.Struct({ nameWithOwner: Schema.String })),
});
const LinkedConnection = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        ...LinkedRequest.fields,
        source: Schema.optional(Schema.NullOr(LinkedRequest)),
      }),
    ),
  ),
});
const LinkedPage = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            closedByPullRequestsReferences: Schema.optional(LinkedConnection),
            timelineItems: Schema.optional(LinkedConnection),
          }),
        ),
      }),
    ),
  }),
});

const isIssueEventKind = Schema.is(IssueEventKind);
const KIND = IssueTrackerKind.make("github");

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
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  involvements: ["all", "assigned", "authored", "mentioned"],
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  closeReasons: ["completed", "not-planned"],
};

/** Where a repository configures the rest of its issue chooser, as GitHub spells the path. */
const TEMPLATE_CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";

function skippedMetadata(
  requested: {
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  },
  response: GitHubApi.GitHubRestResponse,
): ReadonlyArray<string> {
  const decoded = decodeRestIssueMetadataJson(response.body);
  const actual =
    !response.truncated && !response.invalidUtf8 && Result.isSuccess(decoded)
      ? decoded.success
      : undefined;
  const fields = [
    ["labels", requested.labels, actual?.labels?.map((label) => label.name)],
    ["assignees", requested.assignees, actual?.assignees?.map((assignee) => assignee.login)],
  ] as const;
  return fields.flatMap(([name, expected, saved]) => {
    if (expected === undefined) return [];
    if (saved === undefined) return [name];
    const wanted = new Set(expected.map((value) => value.toLowerCase()));
    const received = new Set(saved.map((value) => value.toLowerCase()));
    return wanted.size === received.size && [...wanted].every((value) => received.has(value))
      ? []
      : [name];
  });
}

const decodeTemplateConfig = Schema.decodeUnknownResult(
  fromYaml(
    Schema.Struct({
      blank_issues_enabled: Schema.optionalKey(Schema.Boolean),
      contact_links: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ name: Schema.String, about: Schema.String, url: Schema.String }),
        ),
      ),
    }),
  ),
);

/** What a repository selector may hold before it goes into a search query as itself. */
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The GraphQL and REST APIs take owner and name apart, so `owner/repo` is split here. */
function parseRepository(scope: string): { readonly owner: string; readonly name: string } {
  const parts = scope.trim().split("/").filter(Boolean);
  return { owner: parts.at(-2) ?? "", name: parts.at(-1) ?? "" };
}

/** An issue key is its number; anything else names no GitHub issue. */
function parseNumber(key: string): number | null {
  return /^[1-9]\d*$/.test(key) ? Number(key) : null;
}

/**
 * The reader's words as quoted search terms. Outside quotes GitHub reads `is:closed` as a
 * qualifier, so text typed into a box could widen the listing it narrows; inside them it is only
 * text. Each word is quoted on its own so the words still match apart, not only as a phrase.
 */
function searchTerms(query: string): ReadonlyArray<string> {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
}

const INVOLVEMENT_QUALIFIER: Record<IssueInvolvement, string | null> = {
  all: null,
  assigned: "assignee",
  authored: "author",
  mentioned: "mentions",
};

function searchQuery(input: {
  readonly scope: string;
  readonly state: "all" | "open" | "closed";
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly sort?: "created" | "updated" | "comments";
  readonly order?: "asc" | "desc";
  readonly stateCategories?: ReadonlyArray<
    "backlog" | "unstarted" | "started" | "completed" | "canceled"
  >;
}): string {
  const qualifier = INVOLVEMENT_QUALIFIER[input.involvement];
  const categories = input.stateCategories;
  const open =
    categories === undefined ? input.state !== "closed" : categories.includes("unstarted");
  const closed =
    categories === undefined
      ? input.state !== "open"
      : categories.includes("completed") || categories.includes("canceled");
  const state = open && closed ? "all" : open ? "open" : "closed";
  return [
    // The search index holds pull requests as issues; `is:issue` keeps them out.
    "is:issue",
    `repo:${input.scope.trim()}`,
    ...(state === "all" ? [] : [`is:${state}`]),
    ...(categories === undefined ||
    open ||
    categories.includes("completed") === categories.includes("canceled")
      ? []
      : [categories.includes("canceled") ? 'reason:"not planned"' : "reason:completed"]),
    ...(qualifier === null ? [] : [`${qualifier}:${input.viewer}`]),
    `sort:${input.sort ?? "updated"}-${input.order ?? "desc"}`,
    ...searchTerms(input.query ?? ""),
  ].join(" ");
}

/** The REST close reasons, which the capability names in the contract's own spelling. */
const CLOSE_REASON: Record<string, "completed" | "not_planned"> = {
  completed: "completed",
  "not-planned": "not_planned",
};

/** The tags that mean GitHub is out of reach for this account rather than one request failing. */
function reasonFor(error: GitHubApi.GitHubApiError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return "missing-tool";
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return "unauthenticated";
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return "rate-limited";
    case "GitHubApiNotFoundError":
      return "not-found";
    default:
      return "failed";
  }
}

export const make: Effect.Effect<IssueTrackerApi, never, GitHubApi.GitHubApi> = Effect.gen(
  function* () {
    const api = yield* GitHubApi.GitHubApi;

    const fail = (operation: string) => (error: GitHubApi.GitHubApiError) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error),
        detail: error.message,
        ...("retryAt" in error && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
        cause: error,
      });

    const unreadable = (operation: string, cause: unknown) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "failed",
        detail: `GitHub returned an unreadable ${operation} response.`,
        cause,
      });

    const notFound = (operation: string) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "not-found",
        detail: "GitHub could not find the requested issue.",
      });

    /** A GraphQL read whose answer is decoded, reporting a failure against the read that made it. */
    const graphqlRead = <A>(input: {
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
      readonly decode: (raw: string) => Result.Result<A, unknown>;
    }): Effect.Effect<A, IssueTrackerError> =>
      api
        .graphql({
          host: input.host,
          operation: input.operation,
          query: input.query,
          ...(input.variables === undefined ? {} : { variables: input.variables }),
        })
        .pipe(
          Effect.mapError(fail(input.operation)),
          Effect.flatMap((raw) => {
            const decoded = input.decode(raw.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(unreadable(input.operation, decoded.failure));
          }),
        );

    const mutate = (input: {
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables: Readonly<Record<string, unknown>>;
    }) => api.graphql(input).pipe(Effect.asVoid, Effect.mapError(fail(input.operation)));

    /** The issue as REST addresses it, or a not-found for a key that names no number. */
    const restIssue = (
      input: { readonly scope: string; readonly key: string },
      operation: string,
    ): Effect.Effect<
      {
        readonly owner: string;
        readonly name: string;
        readonly number: number;
        readonly path: string;
      },
      IssueTrackerError
    > => {
      const number = parseNumber(input.key);
      const { owner, name } = parseRepository(input.scope);
      return number === null
        ? Effect.fail(notFound(operation))
        : Effect.succeed({ owner, name, number, path: `repos/${owner}/${name}/issues/${number}` });
    };

    /** Every write to an issue's own fields is one `PATCH`; only its body differs. */
    const patchIssue = (
      input: { readonly host: string; readonly scope: string; readonly key: string },
      operation: string,
      body: {
        readonly title?: string;
        readonly body?: string;
        readonly labels?: ReadonlyArray<string>;
        readonly assignees?: ReadonlyArray<string>;
        readonly state?: string;
        readonly state_reason?: string;
      },
    ) =>
      restIssue(input, operation).pipe(
        Effect.flatMap(({ path }) =>
          api.rest({ host: input.host, operation, method: "PATCH", path, body }).pipe(
            Effect.mapError(fail(operation)),
            Effect.flatMap((response) => {
              if (body.labels === undefined && body.assignees === undefined) return Effect.void;
              const skipped = skippedMetadata(body, response);
              return skipped.length === 0
                ? Effect.void
                : Effect.fail(
                    new IssueTrackerError({
                      tracker: KIND,
                      operation,
                      reason: "failed",
                      detail: `GitHub did not save the requested ${skipped.join(" and ")}.`,
                    }),
                  );
            }),
          ),
        ),
      );

    /**
     * A client-given comment id is trusted to be whatever node it names, which can hang off any
     * issue on the host; the mutation would write wherever it belongs unless this agrees first.
     */
    const restRead = <A>(
      input: IssueScopeTarget,
      operation: string,
      path: string,
      schema: Schema.Codec<A, unknown, never, never>,
      method?: "POST" | "PATCH" | "DELETE",
      body?: unknown,
    ) =>
      api
        .rest({
          host: input.host,
          operation,
          path,
          ...(method ? { method } : {}),
          ...(body === undefined ? {} : { body }),
        })
        .pipe(
          Effect.mapError(fail(operation)),
          Effect.flatMap((response) => {
            const decoded = decodeJsonResult(schema)(response.body);
            return !response.truncated && !response.invalidUtf8 && Result.isSuccess(decoded)
              ? Effect.succeed({ value: decoded.success, headers: response.headers })
              : Effect.fail(unreadable(operation, response));
          }),
        );

    const restPage = <A>(
      input: IssueScopeTarget & IssuePageInput,
      operation: string,
      path: string,
      schema: Schema.Codec<A, unknown, never, never>,
    ) => {
      const page =
        input.cursor === undefined
          ? 1
          : /^[1-9]\d{0,6}$/.test(input.cursor)
            ? Number(input.cursor)
            : null;
      if (page === null) return Effect.fail(unreadable(operation, "invalid-cursor"));
      const limit = Math.min(input.limit ?? 50, 100);
      return restRead(
        input,
        operation,
        `${path}?per_page=${limit}&page=${page}`,
        Schema.Array(schema),
      ).pipe(
        Effect.map(({ value, headers }) => ({
          items: value,
          nextCursor: /rel="next"/.test(headers.link ?? "") ? String(page + 1) : null,
        })),
      );
    };

    const relatedIssue = (
      input: IssueScopeTarget,
      row: typeof RelatedIssue.Type,
    ): Effect.Effect<IssueRelation, IssueTrackerError> => {
      if (!URL.canParse(row.html_url))
        return Effect.fail(unreadable("getHierarchy", "invalid-url"));
      const url = new URL(row.html_url);
      const match = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (
        !match ||
        !["http:", "https:"].includes(url.protocol) ||
        url.host.toLowerCase() !== input.host.toLowerCase() ||
        match[2] !== String(row.number) ||
        row.pull_request !== undefined
      ) {
        return Effect.fail(unreadable("getHierarchy", "invalid-related-issue"));
      }
      return Effect.succeed({
        scope: match[1]!,
        key: String(row.number),
        displayKey: `#${row.number}`,
        title: row.title,
        url: row.html_url,
        state: {
          category: row.state,
          name: row.state,
          workflowCategory:
            row.state === "open"
              ? "unstarted"
              : row.state_reason === "not_planned"
                ? "canceled"
                : "completed",
        },
      });
    };

    const readRelatedIssue = (input: IssueTarget, operation: string) =>
      restIssue(input, operation).pipe(
        Effect.flatMap(({ path }) => restRead(input, operation, path, RelatedIssue)),
        Effect.flatMap(({ value }) =>
          relatedIssue(input, value).pipe(
            Effect.filterOrFail(
              (ref) =>
                ref.key === input.key && ref.scope.toLowerCase() === input.scope.toLowerCase(),
              () => notFound(operation),
            ),
            Effect.as(value),
          ),
        ),
      );

    const parentIssue = (input: IssueTarget) =>
      restIssue(input, "getHierarchy").pipe(
        Effect.flatMap(({ path }) =>
          restRead(input, "getHierarchy", `${path}/parent`, RelatedIssue),
        ),
        Effect.map(({ value }) => value),
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      );

    const attachParent = (input: IssueScopeTarget, parentKey: string, childId: number) =>
      restIssue({ ...input, key: parentKey }, "setParent").pipe(
        Effect.flatMap(({ path }) =>
          restRead(input, "setParent", `${path}/sub_issues`, Schema.Unknown, "POST", {
            sub_issue_id: childId,
            replace_parent: true,
          }),
        ),
        Effect.asVoid,
      );

    const commentBelongsToIssue = (input: {
      readonly host: string;
      readonly scope: string;
      readonly key: string;
      readonly commentId: string;
      readonly operation: string;
    }) =>
      restIssue(input, input.operation).pipe(
        Effect.flatMap(({ owner, name, number }) =>
          graphqlRead({
            host: input.host,
            operation: input.operation,
            query: ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
            variables: { owner, name, number, commentId: input.commentId },
            decode:
              input.operation === "editComment"
                ? decodeIssueEditableCommentScopeJson
                : decodeIssueCommentScopeJson,
          }),
        ),
        Effect.flatMap((belongs) =>
          belongs
            ? Effect.succeed(input.commentId)
            : Effect.fail(
                new IssueTrackerError({
                  tracker: KIND,
                  operation: input.operation,
                  reason: "failed",
                  detail: "The comment does not belong to the selected issue.",
                }),
              ),
        ),
      );

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getViewer: (input) =>
        graphqlRead({
          host: input.host,
          operation: "getViewer",
          query: "query { viewer { login } }",
          decode: decodeViewerLoginJson,
        }),

      listIssues: (input) => {
        if (!SEARCH_REPOSITORY.test(input.scope.trim())) {
          // A name holding a space could end the `repo:` qualifier and start one of its own, so
          // an unaddressable one refuses the read rather than being escaped into something GitHub
          // might still read.
          return Effect.fail(
            new IssueTrackerError({
              tracker: KIND,
              operation: "listIssues",
              reason: "failed",
              detail: "A repository was named that GitHub cannot address.",
            }),
          );
        }
        if (
          input.stateCategories?.length === 0 ||
          input.stateCategories?.every(
            (category) => category === "backlog" || category === "started",
          )
        )
          return Effect.succeed({ items: [], nextCursor: null });
        return graphqlRead({
          host: input.host,
          operation: "listIssues",
          query: issueSearchGraphQlQuery(Math.min(input.limit, SEARCH_MAX_ROWS)),
          variables:
            input.cursor === undefined
              ? { q: searchQuery(input) }
              : { q: searchQuery(input), cursor: input.cursor },
          decode: decodeIssueSearchJson,
        }).pipe(
          Effect.map((page) => ({
            ...page,
            items: page.items.filter(
              (item) =>
                input.stateCategories === undefined ||
                (item.state.workflowCategory !== undefined &&
                  input.stateCategories.includes(item.state.workflowCategory)),
            ),
          })),
        );
      },

      getIssue: (input) =>
        restIssue(input, "getIssue").pipe(
          Effect.flatMap(({ owner, name, number, path }) =>
            graphqlRead({
              host: input.host,
              operation: "getIssue",
              query: ISSUE_DETAIL_GRAPHQL_QUERY,
              variables: { owner, name, number },
              decode: decodeIssueDetailJson,
            }).pipe(
              Effect.filterOrFail(
                (detail) => detail !== null,
                () => notFound("getIssue"),
              ),
              Effect.flatMap((detail) =>
                api.rest({ host: input.host, operation: "getIssue", path }).pipe(
                  Effect.mapError(fail("getIssue")),
                  Effect.flatMap((response) => {
                    const labels = decodeRestIssueLabelsJson(response.body);
                    return !response.truncated && !response.invalidUtf8 && Result.isSuccess(labels)
                      ? Effect.succeed({ ...detail, labels: labels.success })
                      : Effect.fail(unreadable("getIssue", response));
                  }),
                ),
              ),
            ),
          ),
        ),

      getComments: (input) =>
        restIssue(input, "getComments").pipe(
          Effect.flatMap(({ owner, name, number }) =>
            graphqlRead({
              host: input.host,
              operation: "getComments",
              query: ISSUE_COMMENTS_GRAPHQL_QUERY,
              variables: { owner, name, number, cursor: input.cursor },
              decode: decodeIssueCommentsJson,
            }),
          ),
        ),

      getViewerPermissions: (input) =>
        restIssue(input, "getViewerPermissions").pipe(
          Effect.flatMap(({ owner, name, number }) =>
            graphqlRead({
              host: input.host,
              operation: "getViewerPermissions",
              query: ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
              variables: { owner, name, number },
              decode: decodeIssueViewerPermissionsJson,
            }),
          ),
        ),

      editComment: (input) =>
        commentBelongsToIssue({ ...input, operation: "editComment" }).pipe(
          Effect.flatMap((id) =>
            mutate({
              host: input.host,
              operation: "editComment",
              query:
                "mutation($id:ID!,$body:String!) { updateIssueComment(input:{id:$id,body:$body}) { issueComment { id } } }",
              variables: { id, body: input.body },
            }),
          ),
        ),

      getHierarchy: (input) =>
        Effect.gen(function* () {
          const { path } = yield* restIssue(input, "getHierarchy");
          const [parent, children] = yield* Effect.all(
            [
              parentIssue(input),
              restPage(input, "getHierarchy", `${path}/sub_issues`, RelatedIssue),
            ],
            { concurrency: 2 },
          );
          return {
            parent: parent === null ? null : yield* relatedIssue(input, parent),
            children: {
              ...children,
              items: yield* Effect.forEach(children.items, (child) => relatedIssue(input, child)),
            },
          };
        }),

      setParent: (input) =>
        Effect.gen(function* () {
          if (input.parentKey === input.key) return yield* unreadable("setParent", "self-parent");
          const child = yield* readRelatedIssue(input, "setParent");
          if (input.parentKey !== null) {
            yield* readRelatedIssue({ ...input, key: input.parentKey }, "setParent");
            yield* attachParent(input, input.parentKey, child.id);
            return;
          }
          const parent = yield* parentIssue(input);
          if (parent === null) return;
          const ref = yield* relatedIssue(input, parent);
          const { path } = yield* restIssue(
            { ...input, scope: ref.scope, key: ref.key },
            "setParent",
          );
          yield* restRead(input, "setParent", `${path}/sub_issue`, Schema.Unknown, "DELETE", {
            sub_issue_id: child.id,
          });
        }),

      getHistory: (input) =>
        restIssue(input, "getHistory").pipe(
          Effect.flatMap(({ path }) =>
            restPage(input, "getHistory", `${path}/timeline`, HistoryEvent),
          ),
          Effect.map((page) => ({
            ...page,
            items: page.items.flatMap((event): IssueEvent[] => {
              if (
                event.created_at == null ||
                event.event === undefined ||
                event.event === "commented" ||
                (event.id === undefined && event.node_id === undefined)
              )
                return [];
              return [
                {
                  id: event.node_id ?? String(event.id),
                  kind: isIssueEventKind(event.event) ? event.event : "updated",
                  createdAt: event.created_at,
                  actor:
                    event.actor == null
                      ? null
                      : {
                          login: event.actor.login,
                          name: null,
                          avatarUrl: event.actor.avatar_url ?? null,
                        },
                  detail:
                    event.rename?.to ??
                    event.label?.name ??
                    event.assignee?.login ??
                    event.event.replaceAll("_", " "),
                },
              ];
            }),
          })),
        ),

      listLabelCandidates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return restPage(
          input,
          "listLabelCandidates",
          `repos/${owner}/${name}/labels`,
          CandidateLabel,
        );
      },

      listAssigneeCandidates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return restPage(
          input,
          "listAssigneeCandidates",
          `repos/${owner}/${name}/assignees`,
          CandidateActor,
        ).pipe(
          Effect.map((page) => ({
            ...page,
            items: page.items.map((actor) => ({
              id: actor.login,
              login: actor.login,
              name: actor.name ?? null,
              avatarUrl: actor.avatar_url ?? null,
            })),
          })),
        );
      },

      getLinkedPullRequests: (input) =>
        Effect.gen(function* () {
          const match = /^(closing|related):(.*)$/.exec(input.cursor ?? "closing:");
          if (match === null) return yield* unreadable("getLinkedPullRequests", "invalid-cursor");
          const closing = match[1] === "closing";
          const { owner, name, number } = yield* restIssue(input, "getLinkedPullRequests");
          const fields =
            "__typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } }";
          const field = closing
            ? `closedByPullRequestsReferences(first:$first,after:$after,includeClosedPrs:true,userLinkedOnly:false) { nodes { ${fields} } pageInfo { hasNextPage endCursor } }`
            : `timelineItems(first:$first,after:$after,itemTypes:[CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { source { ${fields} } } } pageInfo { hasNextPage endCursor } }`;
          const page = yield* graphqlRead({
            host: input.host,
            operation: "getLinkedPullRequests",
            query: `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String) { repository(owner:$owner,name:$name) { issue(number:$number) { ${field} } } }`,
            variables: {
              owner,
              name,
              number,
              first: Math.min(input.limit ?? 50, 100),
              after: match[2] || null,
            },
            decode: (raw) =>
              Result.flatMap(decodeJsonResult(LinkedPage)(raw), ({ data }) => {
                const connection = closing
                  ? data.repository?.issue?.closedByPullRequestsReferences
                  : data.repository?.issue?.timelineItems;
                return connection == null
                  ? Result.fail("missing-issue")
                  : Result.succeed(connection);
              }),
          });
          if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === null)
            return yield* unreadable("getLinkedPullRequests", "missing-cursor");
          const seen = new Set<string>();
          return {
            nextCursor: page.pageInfo.hasNextPage
              ? `${closing ? "closing" : "related"}:${page.pageInfo.endCursor}`
              : closing
                ? "related:"
                : null,
            items: page.nodes.flatMap((node): IssueLinkedPullRequest[] => {
              const pr = node?.source ?? node;
              if (
                pr?.__typename !== "PullRequest" ||
                !pr.number ||
                !pr.title ||
                !pr.url ||
                !pr.repository ||
                seen.has(pr.url)
              )
                return [];
              seen.add(pr.url);
              return [
                {
                  provider: SourceControlProviderKind.make("github"),
                  host: input.host,
                  repository: pr.repository.nameWithOwner,
                  number: pr.number,
                  title: pr.title,
                  url: pr.url,
                  state:
                    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
                  isDraft: pr.isDraft ?? false,
                  closesIssue: closing,
                },
              ];
            }),
          };
        }),

      create: (input) =>
        Effect.gen(function* () {
          if (input.parentKey !== undefined)
            yield* readRelatedIssue({ ...input, key: input.parentKey }, "create");
          const { owner, name } = parseRepository(input.scope);
          const response = yield* api
            .rest({
              host: input.host,
              operation: "create",
              method: "POST",
              path: `repos/${owner}/${name}/issues`,
              body: {
                title: input.title,
                body: input.body,
                labels: input.labels,
                assignees: input.assignees,
              },
            })
            .pipe(Effect.mapError(fail("create")));
          const decoded = decodeCreatedIssueJson(response.body);
          if (!Result.isSuccess(decoded)) return yield* unreadable("create", response);
          const created = {
            key: String(decoded.success.number),
            displayKey: `#${decoded.success.number}`,
            url: decoded.success.url,
            warnings: skippedMetadata(
              {
                labels: input.labels.length === 0 ? undefined : input.labels,
                assignees: input.assignees.length === 0 ? undefined : input.assignees,
              },
              response,
            ).map(
              (field) => `The issue was created, but GitHub did not save the requested ${field}.`,
            ),
          };
          if (input.parentKey === undefined) return created;
          const parentLinked =
            decoded.success.id === undefined
              ? false
              : yield* attachParent(input, input.parentKey, decoded.success.id).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
          return { ...created, parentLinked };
        }),

      comment: (input) =>
        restIssue(input, "comment").pipe(
          Effect.flatMap(({ path }) =>
            api
              .rest({
                host: input.host,
                operation: "comment",
                method: "POST",
                path: `${path}/comments`,
                body: { body: input.body },
              })
              .pipe(Effect.asVoid, Effect.mapError(fail("comment"))),
          ),
        ),

      update: (input) =>
        patchIssue(input, "update", {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        }),

      setState: (input) =>
        patchIssue(input, "setState", {
          state: input.state,
          ...(input.state === "closed" && input.closeReason !== undefined
            ? { state_reason: CLOSE_REASON[input.closeReason] }
            : {}),
        }),

      setReaction: (input) =>
        (input.subjectId === undefined
          ? restIssue(input, "setReaction").pipe(
              Effect.flatMap(({ owner, name, number }) =>
                graphqlRead({
                  host: input.host,
                  operation: "setReaction",
                  query: ISSUE_NODE_ID_GRAPHQL_QUERY,
                  variables: { owner, name, number },
                  decode: decodeIssueNodeIdJson,
                }),
              ),
            )
          : commentBelongsToIssue({
              ...input,
              commentId: input.subjectId,
              operation: "setReaction",
            })
        ).pipe(
          Effect.flatMap((subjectId) =>
            mutate({
              host: input.host,
              operation: "setReaction",
              query: input.reacted
                ? ADD_REACTION_GRAPHQL_MUTATION
                : REMOVE_REACTION_GRAPHQL_MUTATION,
              variables: { subjectId, content: gitHubReactionContent(input.content) },
            }),
          ),
        ),

      listTemplates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return Effect.all(
          [
            graphqlRead({
              host: input.host,
              operation: "listTemplates",
              query: ISSUE_TEMPLATES_GRAPHQL_QUERY,
              variables: { owner, name },
              decode: (raw) =>
                Result.flatMap(decodeIssueTemplatesJson(raw), (templates) =>
                  Result.map(decodeIssueTemplateFilesJson(raw), (entries) => ({
                    templates: templates.filter((template) => !/\.ya?ml$/i.test(template.key)),
                    forms: readGitHubIssueTemplateFiles(entries).templates,
                  })),
                ),
            }),
            // Only an explicit `blank_issues_enabled: false` takes the blank issue away; a missing
            // config, or one this account may not read, leaves it where GitHub puts it.
            api
              .rest({
                host: input.host,
                operation: "listTemplateConfig",
                accept: "application/vnd.github.raw",
                path: `repos/${owner}/${name}/contents/${TEMPLATE_CONFIG_PATH}`,
              })
              .pipe(
                Effect.map((response) => {
                  const config = decodeTemplateConfig(response.body);
                  return Result.isSuccess(config)
                    ? {
                        blankIssuesEnabled: config.success.blank_issues_enabled !== false,
                        contactLinks: config.success.contact_links ?? [],
                      }
                    : { blankIssuesEnabled: true, contactLinks: [] };
                }),
                Effect.catch((error) =>
                  error._tag === "GitHubApiRateLimitError" ||
                  error._tag === "SourceControlRateLimitPausedError"
                    ? Effect.fail(fail("listTemplateConfig")(error))
                    : Effect.succeed({ blankIssuesEnabled: true, contactLinks: [] }),
                ),
              ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([templates, config]) => ({
            templates: [...templates.templates, ...templates.forms],
            blankIssuesEnabled: config.blankIssuesEnabled,
            ...(config.contactLinks.length === 0 ? {} : { contactLinks: config.contactLinks }),
          })),
        );
      },

      listCandidates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return graphqlRead({
          host: input.host,
          operation: "listCandidates",
          query: ISSUE_CANDIDATES_GRAPHQL_QUERY,
          variables: { owner, name },
          decode: decodeIssueCandidatesJson,
        });
      },
    };
  },
);
