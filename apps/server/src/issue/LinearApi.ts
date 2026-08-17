import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { IssueListState, IssueInvolvement, LinearConnection } from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const API_URL = "https://api.linear.app/graphql";
const MAX_PAGE = 250;

export const LINEAR_API_TOKEN_SECRET = "linear.api-token";

const ApiConfig = Config.all({
  baseUrl: Config.string("T3CODE_LINEAR_API_BASE_URL").pipe(Config.withDefault(API_URL)),
  envToken: Config.string("T3CODE_LINEAR_API_TOKEN").pipe(Config.option),
});

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
const Team = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String });
const State = Schema.Struct({ name: Schema.String, type: Schema.String });
const Label = Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.String) });
const Reaction = Schema.Struct({
  id: Schema.String,
  emoji: Schema.String,
  user: Schema.optional(Schema.NullOr(User)),
});
const Comment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(User)),
  reactions: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Reaction) }))),
});
const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  canceledAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: State,
  creator: Schema.optional(Schema.NullOr(User)),
  assignee: Schema.optional(Schema.NullOr(User)),
  labels: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Label) }))),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Comment),
        pageInfo: Schema.optional(Schema.Struct({ hasNextPage: Schema.Boolean })),
      }),
    ),
  ),
  reactions: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Reaction) }))),
});

const Errors = { errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))) };
const ConnectionEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    viewer: Schema.NullOr(User),
    teams: Schema.Struct({ nodes: Schema.Array(Team) }),
  }),
});
const ViewerEnvelope = Schema.Struct({ ...Errors, data: Schema.Struct({ viewer: User }) });
const ListEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(Issue) }) }),
});
const IssueEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ issue: Schema.NullOr(Issue) }),
});
const ActivityEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ viewer: User, issue: Schema.NullOr(Issue) }),
});
const ReactionLookupEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    viewer: User,
    issue: Schema.optional(
      Schema.NullOr(Schema.Struct({ reactions: Schema.Struct({ nodes: Schema.Array(Reaction) }) })),
    ),
    comment: Schema.optional(
      Schema.NullOr(Schema.Struct({ reactions: Schema.Struct({ nodes: Schema.Array(Reaction) }) })),
    ),
  }),
});
const MutationEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Record(Schema.String, Schema.Struct({ success: Schema.Boolean })),
});

const USER_FIELDS = "id name email avatarUrl";
const REACTION_FIELDS = `id emoji user { ${USER_FIELDS} }`;
const ISSUE_FIELDS = `
  id identifier number title url description createdAt updatedAt completedAt canceledAt
  state { name type }
  creator { ${USER_FIELDS} }
  assignee { ${USER_FIELDS} }
  labels { nodes { name color } }
`;

const CONNECTION_QUERY = `query T3LinearConnection {
  viewer { ${USER_FIELDS} }
  teams(first: 250) { nodes { id key name } }
}`;
const VIEWER_QUERY = `query T3LinearViewer { viewer { ${USER_FIELDS} } }`;
const LIST_QUERY = `query T3LinearIssues($first: Int!, $filter: IssueFilter!) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
}`;
const ISSUE_QUERY = `query T3LinearIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;
const ACTIVITY_QUERY = `query T3LinearIssueActivity($id: String!, $comments: Int!) {
  viewer { id name email avatarUrl }
  issue(id: $id) {
    ${ISSUE_FIELDS}
    comments(first: $comments) {
      nodes { id body createdAt url user { ${USER_FIELDS} } reactions { nodes { ${REACTION_FIELDS} } } }
      pageInfo { hasNextPage }
    }
    reactions { nodes { ${REACTION_FIELDS} } }
  }
}`;
const COMMENT_MUTATION = `mutation T3LinearComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
const REACTION_CREATE_MUTATION = `mutation T3LinearReactionCreate($input: ReactionCreateInput!) {
  reactionCreate(input: $input) { success }
}`;
const REACTION_DELETE_MUTATION = `mutation T3LinearReactionDelete($id: String!) {
  reactionDelete(id: $id) { success }
}`;
const ISSUE_REACTIONS_QUERY = `query T3LinearIssueReactions($id: String!) {
  viewer { id name email avatarUrl }
  issue(id: $id) { reactions { nodes { ${REACTION_FIELDS} } } }
}`;
const COMMENT_REACTIONS_QUERY = `query T3LinearCommentReactions($id: String!) {
  viewer { id name email avatarUrl }
  comment(id: $id) { reactions { nodes { ${REACTION_FIELDS} } } }
}`;

export class LinearApiError extends Data.TaggedError("LinearApiError")<{
  readonly reason: "unauthenticated" | "failed";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type LinearUser = typeof User.Type;
export type LinearIssue = typeof Issue.Type;
export type LinearComment = typeof Comment.Type;
export type LinearReaction = typeof Reaction.Type;

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly connection: Effect.Effect<LinearConnection, LinearApiError>;
    readonly connect: (token: string) => Effect.Effect<LinearConnection, LinearApiError>;
    readonly disconnect: Effect.Effect<LinearConnection, LinearApiError>;
    readonly getViewer: Effect.Effect<LinearUser, LinearApiError>;
    readonly listIssues: (input: {
      readonly teamKey: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string;
      readonly updatedBefore?: string;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<LinearIssue>; readonly truncated: boolean },
      LinearApiError
    >;
    readonly getIssue: (identifier: string) => Effect.Effect<LinearIssue, LinearApiError>;
    readonly getActivity: (identifier: string) => Effect.Effect<
      {
        readonly viewerId: string;
        readonly comments: ReadonlyArray<LinearComment>;
        readonly reactions: ReadonlyArray<LinearReaction>;
        readonly commentsTruncated: boolean;
      },
      LinearApiError
    >;
    readonly comment: (input: {
      readonly issueId: string;
      readonly body: string;
    }) => Effect.Effect<void, LinearApiError>;
    readonly setReaction: (input: {
      readonly issueId: string;
      readonly commentId?: string;
      readonly emoji: string;
      readonly reacted: boolean;
    }) => Effect.Effect<void, LinearApiError>;
  }
>()("t3/issue/LinearApi") {}

const clean = (value: string | null | undefined) => value?.trim() || null;
const isAuthError = (message: string) => /auth|api key|access token/i.test(message);

export const make = Effect.gen(function* () {
  const config = yield* ApiConfig;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const storedToken = secrets.get(LINEAR_API_TOKEN_SECRET).pipe(
    Effect.mapError(
      (cause) =>
        new LinearApiError({
          reason: "failed",
          detail: "Could not read the saved Linear token.",
          cause,
        }),
    ),
    Effect.map((value) => Option.map(value, (bytes) => new TextDecoder().decode(bytes).trim())),
  );
  const auth = storedToken.pipe(
    Effect.map((stored) => ({
      token: Option.orElse(stored, () => config.envToken),
      hasStoredToken: Option.isSome(stored),
    })),
  );
  const token = auth.pipe(
    Effect.flatMap(({ token }) =>
      Option.match(token, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              reason: "unauthenticated",
              detail: "Connect Linear in Settings.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

  const request = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    schema: S,
  ): Effect.Effect<S["Type"], LinearApiError> =>
    token.pipe(
      Effect.flatMap((key) =>
        http.execute(
          HttpClientRequest.post(config.baseUrl).pipe(
            HttpClientRequest.setHeader("authorization", key),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        cause instanceof LinearApiError
          ? cause
          : new LinearApiError({
              reason: "failed",
              detail: `Linear ${operation} request failed.`,
              cause,
            }),
      ),
      Effect.flatMap((response) =>
        response.status === 401 || response.status === 403
          ? Effect.fail(
              new LinearApiError({
                reason: "unauthenticated",
                detail: "Linear rejected the API token.",
              }),
            )
          : response.status < 200 || response.status >= 300
            ? Effect.fail(
                new LinearApiError({
                  reason: "failed",
                  detail: `Linear returned HTTP ${response.status}.`,
                }),
              )
            : HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.mapError(
                  (cause) =>
                    new LinearApiError({
                      reason: "failed",
                      detail: "Linear returned an invalid response.",
                      cause,
                    }),
                ),
              ),
      ),
      Effect.flatMap((envelope) => {
        const errors = (envelope as { errors?: ReadonlyArray<{ message: string }> }).errors;
        const message = errors?.[0]?.message;
        return message === undefined
          ? Effect.succeed(envelope)
          : Effect.fail(
              new LinearApiError({
                reason: isAuthError(message) ? "unauthenticated" : "failed",
                detail: message,
              }),
            );
      }),
    );

  const probe = (hasStoredToken: boolean): Effect.Effect<LinearConnection, LinearApiError> =>
    request("connection", CONNECTION_QUERY, {}, ConnectionEnvelope).pipe(
      Effect.map(
        ({ data }): LinearConnection => ({
          status: "authenticated" as const,
          hasStoredToken,
          accountName: clean(data.viewer?.name) ?? "Linear account",
          accountEmail: clean(data.viewer?.email),
          teams: data.teams.nodes.map((team) => ({ id: team.id, key: team.key, name: team.name })),
        }),
      ),
      Effect.catch((error) =>
        error.reason === "unauthenticated"
          ? Effect.succeed<LinearConnection>({
              status: "unauthenticated",
              hasStoredToken,
              accountName: null,
              accountEmail: null,
              teams: [],
            })
          : Effect.succeed<LinearConnection>({
              status: "unverified",
              hasStoredToken,
              accountName: null,
              accountEmail: null,
              teams: [],
            }),
      ),
    );

  const connection = auth.pipe(
    Effect.flatMap(({ token, hasStoredToken }) =>
      Option.isNone(token)
        ? Effect.succeed<LinearConnection>({
            status: "unauthenticated",
            hasStoredToken,
            accountName: null,
            accountEmail: null,
            teams: [],
          })
        : probe(hasStoredToken),
    ),
  );

  const getViewer = request("viewer", VIEWER_QUERY, {}, ViewerEnvelope).pipe(
    Effect.map(({ data }) => data.viewer),
  );

  const issueOrFail = (identifier: string, issue: LinearIssue | null) =>
    issue === null
      ? Effect.fail(
          new LinearApiError({
            reason: "failed",
            detail: `Linear issue ${identifier} was not found.`,
          }),
        )
      : Effect.succeed(issue);

  const mutation = (operation: string, document: string, variables: Record<string, unknown>) =>
    request(operation, document, variables, MutationEnvelope).pipe(
      Effect.flatMap(({ data }) =>
        Object.values(data).some((payload) => payload.success)
          ? Effect.void
          : Effect.fail(
              new LinearApiError({ reason: "failed", detail: `Linear ${operation} failed.` }),
            ),
      ),
    );

  return LinearApi.of({
    connection,
    connect: (value) =>
      secrets.set(LINEAR_API_TOKEN_SECRET, new TextEncoder().encode(value.trim())).pipe(
        Effect.mapError(
          (cause) =>
            new LinearApiError({
              reason: "failed",
              detail: "Could not save the Linear token.",
              cause,
            }),
        ),
        Effect.flatMap(() => probe(true)),
      ),
    disconnect: secrets.remove(LINEAR_API_TOKEN_SECRET).pipe(
      Effect.mapError(
        (cause) =>
          new LinearApiError({
            reason: "failed",
            detail: "Could not remove the Linear token.",
            cause,
          }),
      ),
      Effect.flatMap(() => probe(false)),
    ),
    getViewer,
    listIssues: (input) => {
      const filter: Record<string, unknown> = { team: { key: { eq: input.teamKey } } };
      if (input.state !== "all") {
        const closed = ["completed", "canceled", "duplicate"];
        filter.state = { type: { [input.state === "closed" ? "in" : "nin"]: closed } };
      }
      if (input.involvement !== "all") {
        const relation =
          input.involvement === "assigned"
            ? "assignee"
            : input.involvement === "authored"
              ? "creator"
              : "subscribers";
        filter[relation] =
          relation === "subscribers"
            ? { some: { id: { eq: input.viewer } } }
            : { id: { eq: input.viewer } };
      }
      if (input.query !== undefined) {
        filter.or = [
          { title: { containsIgnoreCase: input.query } },
          { description: { containsIgnoreCase: input.query } },
        ];
      }
      if (input.updatedBefore !== undefined) filter.updatedAt = { lte: input.updatedBefore };
      const first = Math.min(input.limit + 1, MAX_PAGE);
      return request(
        "issue list",
        LIST_QUERY,
        first === 0 ? {} : { first, filter },
        ListEnvelope,
      ).pipe(
        Effect.map(({ data }) => ({
          issues: data.issues.nodes.slice(0, input.limit),
          truncated: data.issues.nodes.length > input.limit,
        })),
      );
    },
    getIssue: (identifier) =>
      request("issue", ISSUE_QUERY, { id: identifier }, IssueEnvelope).pipe(
        Effect.flatMap(({ data }) => issueOrFail(identifier, data.issue)),
      ),
    getActivity: (identifier) =>
      request(
        "issue activity",
        ACTIVITY_QUERY,
        { id: identifier, comments: 50 },
        ActivityEnvelope,
      ).pipe(
        Effect.flatMap(({ data }) =>
          Effect.gen(function* () {
            const issue = yield* issueOrFail(identifier, data.issue);
            return {
              viewerId: data.viewer.id,
              comments: issue.comments?.nodes ?? [],
              reactions: issue.reactions?.nodes ?? [],
              commentsTruncated: issue.comments?.pageInfo?.hasNextPage ?? false,
            };
          }),
        ),
      ),
    comment: ({ issueId, body }) =>
      mutation("comment", COMMENT_MUTATION, { input: { issueId, body } }),
    setReaction: (input) => {
      if (input.reacted) {
        return mutation("reaction", REACTION_CREATE_MUTATION, {
          input:
            input.commentId === undefined
              ? { issueId: input.issueId, emoji: input.emoji }
              : { commentId: input.commentId, emoji: input.emoji },
        });
      }
      const document =
        input.commentId === undefined ? ISSUE_REACTIONS_QUERY : COMMENT_REACTIONS_QUERY;
      const id = input.commentId ?? input.issueId;
      return request("reaction lookup", document, { id }, ReactionLookupEnvelope).pipe(
        Effect.flatMap(({ data }) => {
          const reactions = (data.comment ?? data.issue)?.reactions.nodes ?? [];
          const reaction = reactions.find(
            (item) => item.emoji === input.emoji && item.user?.id === data.viewer.id,
          );
          return reaction === undefined
            ? Effect.void
            : mutation("reaction", REACTION_DELETE_MUTATION, { id: reaction.id });
        }),
      );
    },
  });
});

export const layer = Layer.effect(LinearApi, make);
