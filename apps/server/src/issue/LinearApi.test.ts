import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueProvider from "./LinearIssueProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeSync(Json);
const pool = (...credentials: ReadonlyArray<readonly [credentialId: string, token: string]>) =>
  encodeJson({
    version: 1,
    credentials: credentials.map(([credentialId, token]) => ({ credentialId, token })),
  });

function memorySecrets(
  initial: Readonly<Record<string, string>> = {},
  options: {
    readonly failCredentialReadsAfterWrite?: boolean;
  } = {},
) {
  const values = new Map<string, Uint8Array>();
  let credentialsWritten = false;
  for (const [name, value] of Object.entries(initial)) values.set(name, bytes(value));
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      if (
        name === "issue-trackers.linear.credentials" &&
        credentialsWritten &&
        options.failCredentialReadsAfterWrite === true
      ) {
        return Effect.fail(
          new ServerSecretStore.SecretStoreReadError({ resource: name, cause: "test" }),
        );
      }
      return Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(value);
      });
    },
    set: (name, value) =>
      Effect.sync(() => {
        if (name === "issue-trackers.linear.credentials") credentialsWritten = true;
        values.set(name, value);
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, size) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(size);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  return { service, values };
}

function makeLayer(input: {
  readonly envToken?: string;
  readonly credentials?: string;
  readonly failCredentialReadsAfterWrite?: boolean;
  readonly response: (body: Record<string, unknown>, authorization: string | undefined) => unknown;
}) {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  const secrets = memorySecrets(
    {
      ...(input.credentials === undefined
        ? {}
        : { "issue-trackers.linear.credentials": input.credentials }),
    },
    {
      ...(input.failCredentialReadsAfterWrite === undefined
        ? {}
        : { failCredentialReadsAfterWrite: input.failCredentialReadsAfterWrite }),
    },
  );
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const raw = (request.body as { readonly body?: Uint8Array }).body;
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const authorization = request.headers.authorization;
    requests.push({ body, authorization });
    const response = input.response(body, authorization);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        response instanceof Response ? response : Response.json(response),
      ),
    );
  });
  const layer = LinearApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_LINEAR_API_BASE_URL: "https://linear.test",
            ...(input.envToken === undefined ? {} : { T3CODE_LINEAR_API_TOKEN: input.envToken }),
          },
        }),
      ),
    ),
  );
  return {
    layer,
    requests,
    values: secrets.values,
  };
}

it.effect("reports a disconnected Linear account without making a request", () => {
  const response = vi.fn(() => ({}));
  const { layer } = makeLayer({ response });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.connection, {
      status: "unauthenticated",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      projects: [],
      accounts: [],
    });
    assert.strictEqual(response.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("does not route an absent environment token through a saved account", () => {
  const { layer, requests } = makeLayer({
    credentials: pool(["user-1", "saved-key"]),
    response: () => ({}),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.getViewer({}));
    assert.strictEqual(error.reason, "unauthenticated");
    assert.deepStrictEqual(requests, []);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the environment token for environment-bound teams beside saved accounts", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_env",
    credentials: pool(["user-1", "lin_api_saved"]),
    response: () => ({ data: { viewer: { id: "viewer" } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    yield* api.getViewer({ credentialId: "user-1" });

    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      ["lin_api_env", "lin_api_saved"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports the environment account beside saved accounts", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_env",
    credentials: pool(["user-1", "lin_api_saved"]),
    response: (_body, authorization) => ({
      data: {
        viewer: {
          id: authorization === "lin_api_env" ? "env-user" : "user-1",
          name: authorization === "lin_api_env" ? "Environment account" : "Saved account",
          email: null,
        },
        teams: {
          nodes: [
            authorization === "lin_api_env"
              ? { id: "team-env", key: "ENV", name: "Environment" }
              : { id: "team-saved", key: "SAVED", name: "Saved" },
          ],
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const connection = yield* api.connection;

    assert.strictEqual(connection.accounts[0]?.projects[0]?.key, "SAVED");
    assert.strictEqual(connection.environmentAccount?.projects[0]?.key, "ENV");
    assert.strictEqual(connection.projects[0]?.key, "ENV");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Linear list continuation when the API page cap is reached", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: {
        issues: {
          nodes: [
            {
              id: "issue-1",
              identifier: "ENG-1",
              number: 1,
              title: "First issue",
              url: "https://linear.app/acme/issue/ENG-1",
              description: null,
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              completedAt: null,
              canceledAt: null,
              state: { name: "Open", type: "started" },
              creator: null,
              assignee: null,
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: true, hasPreviousPage: false },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const page = yield* api.listIssues({
      teamKey: "ENG",
      state: "open",
      involvement: "all",
      viewer: "user-1",
      limit: 500,
    });

    assert.isTrue(page.truncated);
  }).pipe(Effect.provide(layer));
});

it.effect("searches an issue key as that team's issue number", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } } },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const base = {
      teamKey: "ENG",
      state: "all",
      involvement: "all",
      viewer: "u",
      limit: 5,
    } as const;
    for (const query of ["eng-12", "#12", "12", "OPS-12", "crash"]) {
      yield* api.listIssues({ ...base, query });
    }
    const numberClauses = requests.map(({ body }) =>
      ((body.variables as { filter: { or: Array<Record<string, unknown>> } }).filter.or ?? []).find(
        (clause) => "number" in clause,
      ),
    );

    assert.deepStrictEqual(numberClauses, [
      { number: { eq: 12 } },
      { number: { eq: 12 } },
      { number: { eq: 12 } },
      undefined,
      undefined,
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("surfaces malformed saved credential storage", () => {
  const { layer } = makeLayer({ credentials: "not-json", response: () => ({}) });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.connection);

    assert.strictEqual(error.reason, "failed");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Linear GraphQL error text out of caller-visible failures", () => {
  const errors = [{ message: "private upstream diagnostic" }];
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: { viewer: { id: "user-1", name: null, email: null, avatarUrl: null } },
      errors,
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.getViewer({}));

    assert.strictEqual(error.operation, "viewer");
    assert.strictEqual(error.reason, "failed");
    assert.notInclude(error.detail, errors[0]!.message);
    assert.deepStrictEqual(error.cause, errors);
  }).pipe(Effect.provide(layer));
});

it.effect("distinguishes GraphQL authentication errors from author and permission errors", () =>
  Effect.gen(function* () {
    for (const [errors, reason] of [
      [[{ message: "Unknown field author" }], "failed"],
      [[{ message: "Authorization denied", extensions: { code: "FORBIDDEN" } }], "failed"],
      [[{ message: "Sign in", extensions: { code: "AUTHENTICATION_ERROR" } }], "unauthenticated"],
      [[{ message: "Authentication required" }], "unauthenticated"],
      [[{ message: "Unknown author" }, { message: "Invalid access token" }], "unauthenticated"],
    ] as const) {
      const { layer } = makeLayer({ envToken: "lin_api_test", response: () => ({ errors }) });
      const error = yield* Effect.gen(function* () {
        const api = yield* LinearApi.LinearApi;
        return yield* api.getViewer({}).pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error.reason, reason);
    }
  }),
);

it.effect("probes a new key before appending a second saved account", () => {
  let values: Map<string, Uint8Array>;
  let newKeyProbed = false;
  const test = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      if (authorization === "lin_api_two" && !newKeyProbed) {
        assert.deepStrictEqual(
          decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
          decodeJson(pool(["user-1", "lin_api_one"])),
        );
        newKeyProbed = true;
      }
      const second = authorization === "lin_api_two";
      return {
        data: {
          viewer: {
            id: second ? "user-2" : "user-1",
            name: second ? "Grace" : "Ada",
            email: second ? "grace@example.com" : "ada@example.com",
          },
          teams: { nodes: [] },
        },
      };
    },
  });
  values = test.values;
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const result = yield* api.connect("lin_api_two");

    assert.deepStrictEqual(
      result.accounts.map(({ credentialId }) => credentialId),
      ["user-1", "user-2"],
    );
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps every account from concurrent connects", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      const suffix =
        authorization === "lin_api_two" ? "2" : authorization === "lin_api_three" ? "3" : "1";
      return {
        data: {
          viewer: { id: `user-${suffix}`, name: `User ${suffix}`, email: null },
          teams: { nodes: [] },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* Effect.all([api.connect("lin_api_two"), api.connect("lin_api_three")], {
      concurrency: "unbounded",
    });

    const saved = decodeJson(
      new TextDecoder().decode(values.get("issue-trackers.linear.credentials")),
    ) as {
      readonly credentials: ReadonlyArray<{ readonly credentialId: string }>;
    };
    assert.deepStrictEqual(saved.credentials.map(({ credentialId }) => credentialId).toSorted(), [
      "user-1",
      "user-2",
      "user-3",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("replaces a reconnected account without changing account order", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_old"], ["user-2", "lin_api_two"]),
    response: (_body, authorization) => ({
      data: {
        viewer: {
          id: authorization === "lin_api_two" ? "user-2" : "user-1",
          name: "Account",
          email: null,
        },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.connect("lin_api_new");

    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_new"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("does not reread credential storage after disconnect commits", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    failCredentialReadsAfterWrite: true,
    response: () => ({
      data: {
        viewer: { id: "user-1", name: "Ada", email: null },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.strictEqual((yield* api.disconnect({ credentialId: "user-1" })).accounts.length, 0);
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool()),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("routes requests through the selected saved account", () => {
  const { layer, requests } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"]),
    response: (_body, authorization) => ({
      data: { viewer: { id: authorization === "lin_api_one" ? "user-1" : "user-2" } },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const getViewer = api.getViewer as unknown as (input: {
      readonly credentialId: string;
    }) => Effect.Effect<LinearApi.LinearUser, LinearApi.LinearApiError>;
    assert.strictEqual((yield* getViewer({ credentialId: "user-1" })).id, "user-1");
    assert.strictEqual((yield* getViewer({ credentialId: "user-2" })).id, "user-2");
    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      ["lin_api_one", "lin_api_two"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("deletes only the selected saved account", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"]),
    response: () => ({
      data: {
        viewer: { id: "user-2", name: "Grace", email: "grace@example.com" },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const disconnect = api.disconnect as unknown as (input: {
      readonly credentialId: string;
    }) => Effect.Effect<unknown, LinearApi.LinearApiError>;
    yield* disconnect({ credentialId: "user-1" });

    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("loads Linear activity reactions from API arrays", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      return {
        data: {
          viewer: { id: "user-1", name: "Ada", email: "ada@example.com" },
          issue: {
            id: "issue-1",
            identifier: "ENG-7",
            number: 7,
            title: "Activity",
            url: "https://linear.app/eng/issue/ENG-7",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            state: { name: "In Progress", type: "started" },
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  body: "Newest",
                  createdAt: "2026-08-18T00:00:00.000Z",
                  reactions: [],
                },
                {
                  id: "comment-1",
                  body: "Looks good",
                  createdAt: "2026-08-17T00:00:00.000Z",
                  reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
                },
              ],
              pageInfo: { hasNextPage: false },
            },
            reactions: [{ id: "reaction-2", emoji: "🎉", user: { id: "user-2" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.getActivity({ identifier: "ENG-7" }), {
      viewerId: "user-1",
      comments: [
        {
          id: "comment-1",
          body: "Looks good",
          createdAt: "2026-08-17T00:00:00.000Z",
          reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
        },
        {
          id: "comment-2",
          body: "Newest",
          createdAt: "2026-08-18T00:00:00.000Z",
          reactions: [],
        },
      ],
      reactions: [{ id: "reaction-2", emoji: "🎉", user: { id: "user-2" } }],
      commentsTruncated: false,
      nextCommentsCursor: null,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("continues Linear comments without repeating rows and keeps the selected account", () => {
  const comments = Array.from({ length: 60 }, (_, index) => ({
    id: `comment-${index}`,
    body: `Comment ${index}`,
    createdAt: `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    reactions: [{ id: `reaction-${index}`, emoji: "👍", user: { id: "user-1" } }],
  })).toReversed();
  const { layer, requests } = makeLayer({
    credentials: pool(["account-1", "lin_api_test"]),
    response: (body) => {
      const variables = body.variables as { after?: string; comments: number };
      const start =
        variables.after === undefined
          ? 0
          : comments.findIndex((comment) => comment.id === variables.after) + 1;
      const page = comments.slice(start, start + variables.comments);
      return {
        data: {
          viewer: { id: "user-1" },
          issue: {
            id: "issue-1",
            identifier: "ENG-7",
            number: 7,
            title: "Activity",
            url: "https://linear.app/eng/issue/ENG-7",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            state: { name: "In Progress", type: "started" },
            comments: {
              nodes: page,
              pageInfo: {
                hasNextPage: start + page.length < comments.length,
                endCursor: page.at(-1)?.id ?? null,
              },
            },
            reactions: [],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const first = yield* api.getActivity({ identifier: "ENG-7", credentialId: "account-1" });
    assert.strictEqual(first.comments.length, 50);
    assert.isTrue(first.commentsTruncated);
    const second = yield* api.getActivity({
      identifier: "ENG-7",
      credentialId: "account-1",
      cursor: first.nextCommentsCursor!,
    });
    assert.strictEqual(second.comments.length, 10);
    assert.isFalse(second.commentsTruncated);
    assert.strictEqual(second.nextCommentsCursor, null);
    assert.strictEqual(
      new Set([...first.comments, ...second.comments].map((comment) => comment.id)).size,
      60,
    );
    assert.strictEqual(second.comments[0]?.reactions?.[0]?.user?.id, "user-1");
    assert.deepStrictEqual(
      requests.map((request) => request.authorization),
      ["lin_api_test", "lin_api_test"],
    );
    assert.strictEqual(
      (requests[1]!.body.variables as { after: string }).after,
      first.nextCommentsCursor,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("requests Linear created sorting without an updated continuation filter", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.listIssues({
      teamKey: "ENG",
      state: "all",
      involvement: "all",
      viewer: "user-1",
      limit: 10,
      sort: "created",
      cursor: { updatedBefore: "2026-01-01T00:00:00Z", seenAt: [7] },
    });
    const variables = requests[0]?.body.variables as { orderBy: string; filter: unknown };
    assert.strictEqual(variables.orderBy, "createdAt");
    assert.deepStrictEqual(variables.filter, { team: { key: { eq: "ENG" } } });
  }).pipe(Effect.provide(layer));
});

it.effect("creates and removes Linear issue reactions", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactionCreate")) return { data: { reactionCreate: { success: true } } };
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      return {
        data: {
          viewer: { id: "user-1" },
          issue: {
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: true });
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: false });

    assert.deepStrictEqual((requests[0]?.body.variables as { input: unknown }).input, {
      issueId: "ENG-7",
      emoji: "👍",
    });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, { id: "reaction-1" });
  }).pipe(Effect.provide(layer));
});

it.effect("removes Linear comment reactions from API arrays", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      return {
        data: {
          viewer: { id: "user-1" },
          comment: {
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setReaction({
      issueId: "ENG-7",
      commentId: "comment-1",
      emoji: "👍",
      reacted: false,
    });

    assert.deepStrictEqual(requests[0]?.body.variables, { id: "comment-1" });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, { id: "reaction-1" });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "pages through tied Linear updates without loss and reads the oldest slice in ascending order",
  () => {
    const rows = Array.from({ length: 263 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://linear.app/acme/issue/ENG-${index + 1}`,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: index < 261 ? "2026-07-03T00:00:00.000Z" : `2026-07-0${263 - index}T00:00:00.000Z`,
      state: { name: "Open", type: "started" },
    }));
    const { layer, requests } = makeLayer({
      envToken: "lin_api_test",
      response: (body) => {
        const variables = body.variables as {
          first?: number;
          last?: number;
          after?: string;
          before?: string;
          filter: { updatedAt?: { lte: string }; number?: { nin: number[] } };
        };
        const filtered = rows.filter(
          (row) =>
            (variables.filter.updatedAt === undefined ||
              row.updatedAt <= variables.filter.updatedAt.lte) &&
            !variables.filter.number?.nin.includes(row.number),
        );
        const selected = filtered.slice(
          variables.after === undefined
            ? 0
            : filtered.findIndex((row) => row.id === variables.after) + 1,
          variables.before === undefined
            ? undefined
            : filtered.findIndex((row) => row.id === variables.before),
        );
        const size = variables.first ?? variables.last ?? 50;
        const nodes =
          variables.last === undefined ? selected.slice(0, size) : selected.slice(-size);
        return {
          data: {
            issues: {
              nodes,
              pageInfo: {
                hasNextPage: variables.last === undefined && selected.length > size,
                hasPreviousPage: variables.last !== undefined && selected.length > size,
                startCursor: nodes[0]?.id ?? null,
                endCursor: nodes.at(-1)?.id ?? null,
              },
            },
          },
        };
      },
    });
    return Effect.gen(function* () {
      const provider = yield* LinearIssueProvider.make;
      const input = {
        cwd: "/w",
        repository: "ENG",
        host: "linear.app",
        state: "open",
        involvement: "all",
        viewer: "user-1",
        limit: 10,
      } as const;
      const delivered: number[] = [];
      let cursor: ProviderListCursor | undefined;
      let truncated = true;
      for (let page = 0; page < 28 && truncated; page++) {
        const batch = yield* provider.listIssues({ ...input, cursor });
        delivered.push(...batch.items.map((item) => item.number));
        truncated = batch.truncated;
        const boundary = batch.items.at(-1)?.updatedAt;
        assert.isDefined(boundary);
        cursor = {
          updatedBefore: boundary,
          seenAt: [
            ...(cursor?.updatedBefore === boundary ? (cursor.seenAt ?? []) : []),
            ...batch.items.filter((item) => item.updatedAt === boundary).map((item) => item.number),
          ],
        };
      }
      assert.deepStrictEqual(
        delivered,
        rows.map((row) => row.number),
      );
      assert.isFalse(truncated);
      const oldest = yield* provider.listIssues({ ...input, order: "asc" });
      assert.deepStrictEqual(
        oldest.items.map((item) => item.number),
        [263, 262, 261, 260, 259, 258, 257, 256, 255, 254],
      );
      assert.isTrue(oldest.truncated);
      assert.isFalse(oldest.continues);
      assert.include(String(requests.at(-1)?.body.query), "last: $last");
      const cappedOldest = yield* provider.listIssues({ ...input, limit: 500, order: "asc" });
      assert.strictEqual(cappedOldest.items.length, 263);
      assert.strictEqual(cappedOldest.items[0]?.number, 263);
      assert.isFalse(cappedOldest.truncated);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
        ),
      ),
    );
  },
);

it.effect.each([true, false])(
  "handles compound Linear endpoint limits with Endpoint-Name present: %s",
  (named) => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssueActivity"))
          return Response.json(
            {},
            {
              status: 429,
              headers: {
                ...(named ? { "X-RateLimit-Endpoint-Name": "viewer" } : {}),
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "121000",
              },
            },
          );
        if (query.includes("T3LinearIssueSummary"))
          return {
            data: {
              issue: {
                number: 1,
                title: "Issue",
                url: "https://linear.app/issue/ENG-1",
                state: { name: "Open", type: "started" },
              },
            },
          };
        return { data: { viewer: { id: "user" }, teams: { nodes: [] } } };
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getActivity({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(
        (yield* api.getViewer({ credentialId: "saved" }).pipe(Effect.flip)).retryAt,
        121000,
      );
      yield* api.connection;
      assert.equal(requests.length, 3);
      if (named) {
        yield* api.getIssueSummary({ identifier: "ENG-1" });
        assert.equal(requests.length, 4);
      } else {
        assert.equal(
          (yield* api.getIssueSummary({ identifier: "ENG-1" }).pipe(Effect.flip)).retryAt,
          121000,
        );
        assert.equal(requests.length, 3);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps Linear reaction creation and deletion endpoint pauses separate", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactionCreate"))
        return Response.json(
          {},
          {
            status: 429,
            headers: {
              "X-RateLimit-Endpoint-Name": "reactionCreate",
              "X-RateLimit-Endpoint-Requests-Remaining": "0",
              "X-RateLimit-Endpoint-Requests-Reset": "121000",
            },
          },
        );
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      return {
        data: {
          viewer: { id: "user" },
          issue: { reactions: [{ id: "reaction", emoji: "👍", user: { id: "user" } }] },
        },
      };
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    yield* api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: true }).pipe(Effect.flip);
    yield* api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: false });
    assert.equal(requests.length, 4);
    assert.include(String(requests.at(-1)?.body.query), "reactionDelete");
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  [250, "desc"],
  [198, "asc"],
  [500, "asc"],
] as const)(
  "fetches the complete %s-row %s Linear prefix within the query cost limit",
  ([limit, order]) => {
    const rows = Array.from({ length: 563 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://linear.app/acme/issue/ENG-${index + 1}`,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      state: { name: "Open", type: "started" },
      labels: {
        nodes: Array.from({ length: 50 }, (_, label) => ({
          name: `Label ${label + 1}`,
          color: "abcdef",
        })),
      },
    }));
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: (body) => {
        const query = String(body.query);
        const variables = body.variables as {
          first?: number;
          last?: number;
          after?: string;
          before?: string;
          filter: { number?: { nin: number[] } };
        };
        const fields = query.match(/nodes \{([\s\S]+)\}\s+pageInfo/)![1]!;
        const labels = fields.match(
          /labels(?:\((?:first: (\d+),? *)?(?:includeArchived: true)?\))?\s*\{\s*nodes\s*\{([^{}]+)\}/,
        )!;
        const labelCost =
          Number(labels[1] ?? 50) * (1 + labels[2]!.trim().split(/\s+/).length * 0.1);
        const objectCost = [
          ...fields.matchAll(/(?:state|creator|assignee)\s*\{([^{}]+)\}/g),
        ].reduce((cost, match) => cost + 1 + match[1]!.trim().split(/\s+/).length * 0.1, 0);
        const scalarFields = fields
          .replace(
            /labels(?:\((?:first: \d+,? *)?(?:includeArchived: true)?\))?\s*\{\s*nodes\s*\{[^{}]+\}\s*\}/,
            "",
          )
          .replace(/\w+\s*\{[^{}]+\}/g, "")
          .trim()
          .split(/\s+/);
        const pageFields = query
          .match(/pageInfo\s*\{([^{}]+)\}/)![1]!
          .trim()
          .split(/\s+/);
        const size = variables.first ?? variables.last ?? 50;
        const complexity = Math.ceil(
          size * (1 + scalarFields.length * 0.1 + objectCost + labelCost) +
            1 +
            pageFields.length * 0.1,
        );
        assert.include(query, "labels(includeArchived: true) { nodes { name color } }");
        if (complexity > 10000)
          return { errors: [{ message: "Query exceeds maximum complexity" }] };
        const filtered = rows.filter((row) => !variables.filter.number?.nin.includes(row.number));
        const selected = filtered.slice(
          variables.after === undefined
            ? 0
            : filtered.findIndex((row) => row.id === variables.after) + 1,
          variables.before === undefined
            ? undefined
            : filtered.findIndex((row) => row.id === variables.before),
        );
        const nodes =
          variables.last === undefined ? selected.slice(0, size) : selected.slice(-size);
        return {
          data: {
            issues: {
              nodes,
              pageInfo: {
                hasNextPage: variables.last === undefined && selected.length > size,
                hasPreviousPage: variables.last !== undefined && selected.length > size,
                startCursor: nodes[0]?.id ?? null,
                endCursor: nodes.at(-1)?.id ?? null,
              },
            },
          },
        };
      },
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const input = {
        teamKey: "ENG",
        state: "all",
        involvement: "all",
        viewer: "user",
        limit,
        order,
      } as const;
      const page = yield* api.listIssues(input);
      const expected = order === "asc" ? rows.toReversed().slice(0, limit) : rows.slice(0, limit);
      assert.lengthOf(page.issues, limit);
      assert.deepStrictEqual(page.issues, expected);
      assert.isTrue(page.truncated);
      assert.isAtMost(requests.length, 4);
      assert.isTrue(
        requests.every(({ body }) => {
          const variables = body.variables as { first?: number; last?: number };
          return (variables.first ?? variables.last ?? 0) <= 150;
        }),
      );
      if (order === "desc") {
        const next = yield* api.listIssues({
          ...input,
          cursor: {
            updatedBefore: page.issues.at(-1)!.updatedAt,
            seenAt: page.issues.map((issue) => issue.number),
          },
        });
        assert.deepStrictEqual(next.issues, rows.slice(limit, limit * 2));
        assert.isTrue(next.truncated);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("checks the complexity balance before fetching another Linear list page", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        {
          data: {
            issues: {
              nodes: Array.from({ length: 150 }, (_, index) => ({
                id: `issue-${index}`,
                identifier: `ENG-${index}`,
                number: index,
                title: "Issue",
                url: "https://linear.app/issue",
                createdAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-03T00:00:00.000Z",
                state: { name: "Open", type: "started" },
              })),
              pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: "next" },
            },
          },
        },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "100",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const error = yield* api
      .listIssues({ teamKey: "ENG", state: "all", involvement: "all", viewer: "user", limit: 198 })
      .pipe(Effect.flip);
    assert.equal(error.retryAt, 61000);
    assert.equal(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["requests", "complexity"])(
  "keeps the later shared Linear %s reset when a new key is verified",
  (kind) => {
    const { layer, requests } = makeLayer({
      envToken: "known-key",
      credentials: pool(["new", "new-key"]),
      response: (_body, authorization) =>
        Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers:
              authorization === "new-key"
                ? {
                    "X-RateLimit-Complexity-Remaining": "9999",
                    "X-RateLimit-Complexity-Reset": "61000",
                    "X-RateLimit-Requests-Remaining": "20",
                  }
                : {
                    [`X-RateLimit-${kind}-Remaining`]: kind === "complexity" ? "4000" : "0",
                    [`X-RateLimit-${kind}-Reset`]: "121000",
                  },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "new" });
      for (const credentialId of [undefined, "new"])
        assert.equal(
          (yield* api
            .getIssue({
              identifier: "ENG-1",
              ...(credentialId === undefined ? {} : { credentialId }),
            })
            .pipe(Effect.flip)).retryAt,
          121000,
        );
      assert.equal(requests.length, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("retains an unknown token's endpoint pause when its Linear user is verified", () => {
  const { layer, requests } = makeLayer({
    envToken: "known-key",
    credentials: pool(["new", "new-key"]),
    response: (body) =>
      String(body.query).includes("T3LinearIssues")
        ? Response.json(
            {},
            {
              status: 429,
              headers: {
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "61000",
              },
            },
          )
        : { data: { viewer: { id: "user" } } },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const input = {
      teamKey: "ENG",
      state: "all",
      involvement: "all",
      viewer: "user",
      limit: 5,
    } as const;
    yield* api.getViewer({});
    assert.equal(
      (yield* api.listIssues({ ...input, credentialId: "new" }).pipe(Effect.flip)).retryAt,
      61000,
    );
    yield* api.getViewer({ credentialId: "new" });
    for (const credentialId of [undefined, "new"])
      assert.equal(
        (yield* api
          .listIssues({ ...input, ...(credentialId === undefined ? {} : { credentialId }) })
          .pipe(Effect.flip)).retryAt,
        61000,
      );
    assert.equal(requests.length, 3);
    yield* api.getViewer({});
    assert.equal(requests.length, 4);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["requests", "complexity", "rate-limit", "endpoint", "low-budget"])(
  "shares verified Linear user %s limits across keys without joining different users",
  (kind) => {
    let limited = false;
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"], ["new", "new-key"], ["same-user", "other-key"]),
      response: (body, authorization) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
        if (query.includes("T3LinearComment"))
          return { data: { commentCreate: { success: true } } };
        const payload = {
          data: { viewer: { id: authorization === "other-key" ? "other-user" : "user" } },
        };
        if (!limited || authorization !== "environment-key") return payload;
        return Response.json(payload, {
          status: kind === "rate-limit" || kind === "endpoint" ? 429 : 200,
          headers:
            kind === "rate-limit"
              ? { "Retry-After": "60" }
              : kind === "low-budget"
                ? {
                    "X-RateLimit-Complexity-Remaining": "4000",
                    "X-RateLimit-Complexity-Reset": "61000",
                  }
                : {
                    [`X-RateLimit-${kind === "endpoint" ? "Endpoint-Requests" : kind}-Remaining`]:
                      "0",
                    [`X-RateLimit-${kind === "endpoint" ? "Endpoint-Requests" : kind}-Reset`]:
                      "61000",
                  },
        });
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      limited = true;
      yield* api.getViewer({}).pipe(Effect.exit);
      for (const credentialId of [undefined, "saved"]) {
        const error = yield* (
          kind === "low-budget"
            ? api.getIssue({
                identifier: "ENG-1",
                ...(credentialId === undefined ? {} : { credentialId }),
              })
            : api.getViewer(credentialId === undefined ? {} : { credentialId })
        ).pipe(Effect.flip);
        assert.equal(error.reason, "rate-limited");
        assert.equal(error.retryAt, 61000);
        if (kind === "low-budget")
          assert.equal(
            (yield* api
              .listIssues({
                teamKey: "ENG",
                state: "all",
                involvement: "all",
                viewer: "user",
                limit: 198,
                ...(credentialId === undefined ? {} : { credentialId }),
              })
              .pipe(Effect.flip)).reason,
            "rate-limited",
          );
      }
      assert.equal(requests.length, 3);
      yield* api.getViewer({ credentialId: "new" });
      assert.equal(requests.length, 4);
      assert.equal(
        (yield* (
          kind === "low-budget"
            ? api.getIssue({ identifier: "ENG-1", credentialId: "new" })
            : api.getViewer({ credentialId: "new" })
        ).pipe(Effect.flip)).retryAt,
        61000,
      );
      assert.equal(requests.length, 4);
      yield* api.getViewer({ credentialId: "same-user" });
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1", credentialId: "same-user" }).pipe(Effect.flip))
          .reason,
        "failed",
      );
      assert.equal(requests.length, 6);
      if (kind === "endpoint") {
        yield* api.comment({ issueId: "ENG-1", body: "Hello", credentialId: "saved" });
        assert.equal(requests.length, 7);
      }
      limited = false;
      yield* TestClock.setTime(61000);
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not accept a Linear viewer identity from a failed response", () => {
  let limited = false;
  let failed = true;
  const { layer, requests } = makeLayer({
    envToken: "known-key",
    credentials: pool(["same-user", "unknown-key"]),
    response: (_, authorization) => {
      if (authorization === "unknown-key")
        return {
          data: { viewer: { id: "user" } },
          ...(failed ? { errors: [{ message: "Permission denied" }] } : {}),
        };
      return limited
        ? Response.json({}, { status: 429, headers: { "Retry-After": "60" } })
        : { data: { viewer: { id: "user" } } };
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    assert.equal(
      (yield* api.getViewer({ credentialId: "same-user" }).pipe(Effect.flip)).reason,
      "failed",
    );
    limited = true;
    yield* api.getViewer({}).pipe(Effect.flip);
    failed = false;
    yield* api.getViewer({ credentialId: "same-user" });
    assert.equal(requests.length, 4);
    assert.equal(
      (yield* api.getViewer({ credentialId: "same-user" }).pipe(Effect.flip)).reason,
      "rate-limited",
    );
    assert.equal(requests.length, 4);
  }).pipe(Effect.provide(layer));
});

it.effect("shares Linear pauses across requests, isolates tokens, and resumes at the reset", () => {
  let limited = true;
  const { layer, requests } = makeLayer({
    envToken: "environment-key",
    credentials: pool(["other", "other-key"]),
    response: (_, authorization) =>
      authorization === "environment-key" && limited
        ? Response.json({}, { status: 429, headers: { "Retry-After": "60" } })
        : { data: { viewer: { id: "user" } } },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const first = yield* api.getViewer({}).pipe(Effect.flip);
    assert.equal(first.reason, "rate-limited");
    assert.equal(first.retryAt, 61000);
    assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
    assert.equal(requests.length, 1);
    yield* api.getViewer({ credentialId: "other" });
    assert.equal(requests.length, 2);
    limited = false;
    yield* TestClock.adjust("1 minute");
    yield* api.getViewer({});
    assert.equal(requests.length, 3);
  }).pipe(Effect.provide(layer));
});

it.effect.each([400, 200])(
  "recognizes Linear RATELIMITED errors at HTTP %s without retrying the host",
  (status) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () =>
        Response.json(
          { errors: [{ message: "Too many requests", extensions: { code: "RATELIMITED" } }] },
          {
            status,
            headers: {
              "X-RateLimit-Complexity-Remaining": "0",
              "X-RateLimit-Complexity-Reset": "121000",
            },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 121000);
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).reason, "rate-limited");
      assert.equal(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a successful Linear response and pauses further calls when its budget is empty",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () =>
        Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers: {
              "X-RateLimit-Requests-Remaining": "0",
              "X-RateLimit-Requests-Reset": "61000",
            },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      assert.equal((yield* api.getViewer({})).id, "user");
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
      assert.equal(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "blocks details with a positive low balance while allowing cheap calls and other tokens",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["other", "other-key"]),
      response: (body) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
        if (query.includes("T3LinearComment"))
          return { data: { commentCreate: { success: true } } };
        return Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers: {
              "X-Complexity": "2",
              "X-RateLimit-Complexity-Remaining": "4000",
              "X-RateLimit-Complexity-Reset": "61000",
            },
          },
        );
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      const error = yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }));
      assert.equal(error.reason, "rate-limited");
      assert.equal(error.retryAt, 61000);
      assert.equal(requests.length, 1);
      assert.equal((yield* api.getViewer({})).id, "user");
      yield* api.comment({ issueId: "issue-1", body: "Hello" });
      assert.equal(requests.length, 3);
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-1", credentialId: "other" }))).reason,
        "failed",
      );
      assert.equal(requests.length, 4);
      yield* TestClock.setTime(61000);
      assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).reason, "failed");
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("stops queued distinct detail reads after the first low-budget response", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        { data: { issue: null } },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "4000",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const errors = yield* Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        Effect.flip(api.getIssue({ identifier: `ENG-${index + 1}` })),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(requests.length, 1);
    assert.equal(errors.filter((error) => error.reason === "failed").length, 1);
    assert.equal(errors.filter((error) => error.reason === "rate-limited").length, 19);
    assert.ok(
      errors
        .filter((error) => error.reason === "rate-limited")
        .every((error) => error.retryAt === 61000),
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([200, 500])(
  "deducts detail cost without headers even on HTTP %s failure",
  (status) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: (body) => {
        if (String(body.query).includes("T3LinearIssue("))
          return Response.json({ data: { issue: null } }, { status });
        return requests.length === 1
          ? Response.json(
              { data: { viewer: { id: "user" } } },
              {
                headers: {
                  "X-Complexity": "2",
                  "X-RateLimit-Complexity-Remaining": "9000",
                  "X-RateLimit-Complexity-Reset": "61000",
                },
              },
            )
          : { data: { viewer: { id: "user" } } };
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }))).reason, "failed");
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).reason,
        "rate-limited",
      );
      assert.equal(requests.length, 2);
      yield* api.getViewer({});
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-3" }))).reason,
        "rate-limited",
      );
      assert.equal(requests.length, 3);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("uses observed document costs and refreshes positive balances", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
      if (query.includes("T3LinearViewer"))
        return requests.length === 1
          ? Response.json(
              { data: { viewer: { id: "user" } } },
              {
                headers: {
                  "X-Complexity": "7",
                  "X-RateLimit-Complexity-Remaining": "6",
                  "X-RateLimit-Complexity-Reset": "61000",
                },
              },
            )
          : { data: { viewer: { id: "user" } } };
      return Response.json(
        { data: { commentCreate: { success: true } } },
        {
          headers: {
            "X-Complexity": "1",
            ...(requests.length === 2
              ? {}
              : {
                  "X-RateLimit-Complexity-Remaining": "5500",
                  "X-RateLimit-Complexity-Reset": "121000",
                }),
          },
        },
      );
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    assert.equal((yield* Effect.flip(api.getViewer({}))).retryAt, 61000);
    assert.equal(requests.length, 1);
    yield* api.comment({ issueId: "issue-1", body: "Hello" });
    yield* api.comment({ issueId: "issue-1", body: "Again" });
    assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }))).reason, "failed");
    assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).retryAt, 121000);
    yield* api.getViewer({});
    assert.equal(requests.length, 5);
  }).pipe(Effect.provide(layer));
});

it.effect("reads a Linear issue summary without its body, labels, or comments", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({
      data: {
        issue: {
          number: 7,
          title: "Bug",
          url: "https://linear.app/test/issue/DEV-7",
          state: { name: "Done", type: "completed" },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.equal((yield* api.getIssueSummary({ identifier: "DEV-7" })).number, 7);
    assert.equal(requests.length, 1);
    const query = String(requests[0]?.body.query);
    assert.ok(query.includes("number title url state"));
    assert.ok(!/description|labels|comments|viewer/.test(query));
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the three-level Linear detail query below the complexity limit", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({ data: { issue: null } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }));
    const query = String(requests[0]?.body.query);
    assert.include(query, "attachments(first: 50)");
    const childLimits = [...query.matchAll(/children\(first: (\d+)\)/g)].map((match) =>
      Number(match[1]),
    );
    assert.lengthOf(childLimits, 3);
    const attachmentLimits = [...query.matchAll(/attachments(?:\(first: (\d+)\))?/g)].map((match) =>
      Number(match[1] ?? 50),
    );
    assert.lengthOf(attachmentLimits, 3);
    const [children, grandchildren, greatGrandchildren] = childLimits;
    const [issueAttachments, parentAttachments, childAttachments] = attachmentLimits;
    const attachmentCost = 1 + 4 * 0.1;
    const relativeCost = 1 + 3 * 0.1 + (1 + 0.1) + (1 + 2 * 0.1);
    const issueCost = 1 + 10 * 0.1 + (1 + 2 * 0.1) + 2 * (1 + 4 * 0.1) + 50 * (1 + 2 * 0.1);
    const complexity = Math.ceil(
      issueCost +
        issueAttachments! * attachmentCost +
        3 * relativeCost +
        parentAttachments! * attachmentCost +
        children! *
          (relativeCost +
            childAttachments! * attachmentCost +
            grandchildren! * (relativeCost + greatGrandchildren! * relativeCost)),
    );
    assert.isBelow(complexity, 5_000);
  }).pipe(Effect.provide(layer));
});

it.effect("queries and decodes team keys on Linear issue relatives", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          number: 1,
          title: "Epic",
          url: "https://linear.app/acme/issue/ENG-1",
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
          state: { name: "Todo", type: "unstarted" },
          parent: {
            number: 7,
            title: "Initiative",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
            state: { name: "Todo", type: "unstarted" },
          },
          children: {
            nodes: [
              {
                number: 42,
                title: "Engineering part",
                url: "https://linear.app/acme/issue/ENG-42",
                team: { key: "ENG" },
                state: { name: "Todo", type: "unstarted" },
              },
              {
                number: 42,
                title: "Operations part",
                url: "https://linear.app/acme/issue/OPS-42",
                team: { key: "OPS" },
                state: { name: "Todo", type: "unstarted" },
              },
            ],
          },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const issue = yield* api.getIssue({ identifier: "ENG-1" });
    assert.deepStrictEqual(issue.parent?.team, { key: "OPS" });
    assert.deepStrictEqual(
      issue.children?.nodes.map((child) => [child.team.key, child.number]),
      [
        ["ENG", 42],
        ["OPS", 42],
      ],
    );
    assert.include(String(requests[0]?.body.query), "team { key }");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "shares the native Linear issue endpoint across detail, summary, activity, and reaction reads",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              {},
              {
                status: 429,
                headers: {
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      const account = { credentialId: "saved" };
      for (const [read, operation] of [
        [api.getIssueSummary({ identifier: "ENG-1", ...account }), "issue summary"],
        [api.getActivity({ identifier: "ENG-1", ...account }), "issue activity"],
        [
          api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: false, ...account }),
          "reaction lookup",
        ],
      ] as const) {
        const error = yield* read.pipe(Effect.flip);
        assert.equal(error.retryAt, 121000);
        assert.equal(error.operation, operation);
      }
      assert.equal(requests.length, 3);
      yield* api.getViewer(account);
      assert.equal(requests.length, 4);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  [429, "requests"],
  [400, "requests"],
  [200, "requests"],
  [429, "complexity"],
  [400, "complexity"],
  [200, "complexity"],
] as const)(
  "keeps separate global and endpoint resets for HTTP %s %s exhaustion",
  ([status, kind]) => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              { errors: [{ message: "Too many requests", extensions: { code: "RATELIMITED" } }] },
              {
                status,
                headers: {
                  [`X-RateLimit-${kind}-Remaining`]: "0",
                  [`X-RateLimit-${kind}-Reset`]: "61000",
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(
        (yield* api.getViewer({ credentialId: "saved" }).pipe(Effect.flip)).retryAt,
        61000,
      );
      assert.equal(requests.length, 3);
      yield* TestClock.setTime(61000);
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(requests.length, 4);
      for (const account of [{}, { credentialId: "saved" }] as const) {
        const error = yield* api.getIssue({ identifier: "ENG-1", ...account }).pipe(Effect.flip);
        assert.equal(error.retryAt, 121000);
        const attachments = yield* api
          .getAttachments({ identifier: "ENG-1", cursor: "page-50", ...account })
          .pipe(Effect.flip);
        assert.equal(attachments.retryAt, 121000);
      }
      assert.equal(requests.length, 4);
      yield* TestClock.setTime(121000);
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a later Retry-After on the affected Linear endpoint after the global reset",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              {},
              {
                status: 429,
                headers: {
                  "Retry-After": "180",
                  "X-RateLimit-Requests-Remaining": "0",
                  "X-RateLimit-Requests-Reset": "61000",
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip)).retryAt,
        181000,
      );
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
      yield* TestClock.setTime(61000);
      yield* api.getViewer({});
      yield* TestClock.setTime(121000);
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1", credentialId: "saved" }).pipe(Effect.flip))
          .retryAt,
        181000,
      );
      assert.equal(requests.length, 4);
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an endpoint pause does not block other Linear operations", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) =>
      String(body.query).includes("T3LinearViewer")
        ? Response.json(
            {},
            {
              status: 429,
              headers: {
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "61000",
              },
            },
          )
        : {
            data: {
              issue: {
                number: 7,
                title: "Bug",
                url: "https://linear.app/test/issue/DEV-7",
                state: { name: "Done", type: "completed" },
              },
            },
          },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({}).pipe(Effect.flip);
    yield* api.getViewer({}).pipe(Effect.flip);
    assert.equal(requests.length, 1);
    yield* api.getIssueSummary({ identifier: "DEV-7" });
    assert.equal(requests.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("loads PR attachments after an empty PR page with one query per page", () => {
  const unrelated = Array.from({ length: 50 }, (_, index) => ({
    url: `https://figma.com/file/${index}`,
    title: "Design",
    sourceType: "figma",
  }));
  const prs = Array.from({ length: 50 }, (_, index) => ({
    url: `https://github.com/acme/web/pull/${index + 1}`,
    title: "Change",
    sourceType: "github",
    metadata: { status: "merged" },
  }));
  const { layer, requests, values } = makeLayer({
    credentials: pool(["saved", "saved-key"]),
    response: (body) => {
      const { after } = body.variables as { after?: string };
      const attachments = {
        nodes: after === "page-50" ? prs : unrelated,
        pageInfo:
          after === "page-100"
            ? { hasNextPage: false, endCursor: "terminal-native" }
            : {
                hasNextPage: true,
                endCursor: after === undefined ? "page-50" : "page-100",
              },
      };
      return {
        data: {
          issue:
            after === undefined
              ? {
                  id: "issue-7",
                  identifier: "ENG-7",
                  number: 7,
                  title: "Bug",
                  url: "https://linear.app/acme/issue/ENG-7",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  updatedAt: "2026-10-01T00:00:00.000Z",
                  state: { name: "Todo", type: "unstarted" },
                  attachments,
                }
              : { attachments },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const adapter = yield* LinearIssueProvider.make;
    const reference = {
      cwd: "/work/web",
      host: "linear.app",
      repository: "ENG",
      number: 7,
      credentialId: "saved",
    };
    const detail = yield* adapter.getIssue(reference);
    assert.deepStrictEqual(detail.linkedPullRequests, []);
    assert.isTrue(detail.linkedPullRequestsTruncated);
    assert.strictEqual(detail.nextLinkedPullRequestsCursor, "page-50");
    assert.isTrue(detail.viewerPermissions?.comment);
    assert.strictEqual(requests.length, 1);
    values.set("issue-trackers.linear.credentials", bytes(pool(["saved", "fresh-key"])));
    const next = yield* adapter.getIssueLinkedPullRequests({
      ...reference,
      cursor: detail.nextLinkedPullRequestsCursor!,
    });
    assert.deepStrictEqual(
      next.linkedPullRequests.map((pr) => [pr.number, pr.state, pr.closesIssue]),
      prs.map((_, index) => [index + 1, "merged", false]),
    );
    assert.isTrue(next.truncated);
    assert.strictEqual(next.nextCursor, "page-100");
    assert.strictEqual(requests.length, 2);
    const last = yield* adapter.getIssueLinkedPullRequests({
      ...reference,
      cursor: next.nextCursor!,
    });
    assert.deepStrictEqual(last, { linkedPullRequests: [], truncated: false, nextCursor: null });
    assert.deepStrictEqual(
      requests.map((request) => request.body.variables),
      [{ id: "ENG-7" }, { id: "ENG-7", after: "page-50" }, { id: "ENG-7", after: "page-100" }],
    );
    assert.deepStrictEqual(
      requests.map((request) => request.authorization),
      ["saved-key", "fresh-key", "fresh-key"],
    );
    assert.include(String(requests[0]?.body.query), "pageInfo { hasNextPage endCursor }");
    for (const request of requests.slice(1)) {
      const query = String(request.body.query);
      assert.include(query, "attachments(first: 50, after: $after)");
      assert.notMatch(query, /description|comments|history|viewer|parent|children|labels/);
    }
  }).pipe(Effect.provide(Layer.mergeAll(layer, ServerSettings.layerTest())));
});

it.effect.each([undefined, null, "", "   ", "current"])(
  "rejects a missing, malformed, or repeated attachment continuation %s",
  (endCursor) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () => ({
        data: { issue: { attachments: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } } },
      }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const error = yield* api
        .getAttachments({ identifier: "ENG-7", cursor: "current" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([undefined, null, "", "   "])(
  "rejects missing or malformed initial attachment cursors %s",
  (endCursor) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () => ({
        data: {
          issue: {
            id: "issue-7",
            identifier: "ENG-7",
            number: 7,
            title: "Bug",
            url: "https://linear.app/acme/issue/ENG-7",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            state: { name: "Todo", type: "unstarted" },
            attachments: { nodes: [], pageInfo: { hasNextPage: true, endCursor } },
          },
        },
      }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const error = yield* api.getIssue({ identifier: "ENG-7" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["", "   "])("rejects an empty attachment cursor before a request %s", (cursor) => {
  const { layer, requests } = makeLayer({ envToken: "test-key", response: () => ({}) });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* api.getAttachments({ identifier: "ENG-7", cursor }).pipe(Effect.flip);
    assert.strictEqual(error.operation, "issue attachments cursor");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("reserves attachment query complexity before sending HTTP", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        { data: { viewer: { id: "user" } } },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "499",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    const error = yield* api
      .getAttachments({ identifier: "ENG-7", cursor: "page-50" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "rate-limited");
    assert.strictEqual(error.retryAt, 61000);
    assert.strictEqual(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

const WRITE_TEAM = { id: "team-eng", key: "ENG", name: "Engineering", ancestors: [] };
const WRITE_STATES = [
  { id: "done-later", name: "Released", type: "completed", position: 2 },
  { id: "canceled", name: "Won't do", type: "canceled", position: 0 },
  { id: "done", name: "Done", type: "completed", position: 1 },
  { id: "todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "backlog", name: "Backlog", type: "backlog", position: 0 },
];
const WRITE_LABELS = [
  { id: "workspace-bug", name: "Bug", color: "#ff0000", description: null, team: null },
  { id: "team-bug", name: "Bug", color: "#00ff00", description: "Team bug", team: WRITE_TEAM },
  { id: "global", name: "Shared", color: "#0000ff", description: null, team: null },
];
const LAST_PAGE = { hasNextPage: false, endCursor: null };

function writeResponse(body: Record<string, unknown>) {
  const query = String(body.query);
  const variables = body.variables as Record<string, unknown>;
  if (query.includes("T3LinearTeam(")) return { data: { teams: { nodes: [WRITE_TEAM] } } };
  if (query.includes("T3LinearSelection"))
    return {
      data: {
        issue: { id: "issue-7", assignee: null, labels: { nodes: [], pageInfo: LAST_PAGE } },
      },
    };
  if (query.includes("T3LinearLabels")) {
    const filter = variables.filter as { name?: { in: string[] } };
    return {
      data: {
        issueLabels: {
          nodes: WRITE_LABELS.filter(
            (label) => filter.name === undefined || filter.name.in.includes(label.name),
          ),
          pageInfo: LAST_PAGE,
        },
      },
    };
  }
  if (query.includes("T3LinearMembers")) {
    const filter = variables.filter as { id?: { in: string[] }; email?: { eq: string } };
    return {
      data: {
        team: {
          members: {
            nodes:
              (filter.id === undefined || filter.id.in.includes("user-1")) &&
              (filter.email === undefined || filter.email.eq === "ada@example.com")
                ? [{ id: "user-1", name: "Ada", email: "ada@example.com" }]
                : [],
            pageInfo: LAST_PAGE,
          },
        },
      },
    };
  }
  if (query.includes("T3LinearStates")) {
    return {
      data: {
        team: {
          defaultIssueState: WRITE_STATES[4],
          states: { nodes: WRITE_STATES, pageInfo: LAST_PAGE },
        },
      },
    };
  }
  if (query.includes("T3LinearIssueCreate")) {
    return {
      data: {
        issueCreate: {
          success: true,
          issue: { number: 12, url: "https://linear.app/acme/issue/ENG-12" },
        },
      },
    };
  }
  if (query.includes("T3LinearIssueUpdate")) return { data: { issueUpdate: { success: true } } };
  throw new Error(`Unexpected test query: ${query}`);
}

it.effect("creates in the selected team with native label IDs and one team member", () => {
  const { layer, requests, values } = makeLayer({
    credentials: pool(["account-1", "saved-key"]),
    response: writeResponse,
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const created = yield* api.createIssue({
      teamKey: "ENG",
      title: "A bug",
      body: "  Markdown\n",
      labels: ["Bug", "Shared"],
      assignees: ["user-1"],
      credentialId: "account-1",
    });
    assert.deepStrictEqual(created, { number: 12, url: "https://linear.app/acme/issue/ENG-12" });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      input: {
        teamId: "team-eng",
        title: "A bug",
        description: "  Markdown\n",
        labelIds: ["team-bug", "global"],
        assigneeId: "user-1",
        useDefaultTemplate: false,
      },
    });
    assert.isTrue(requests.every((request) => request.authorization === "saved-key"));
    assert.strictEqual(values.size, 1);
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])("rejects creation success=%s without a created issue", (success) => {
  const { layer } = makeLayer({
    envToken: "test-key",
    response: (body) =>
      String(body.query).includes("T3LinearIssueCreate")
        ? { data: { issueCreate: { success, issue: null } } }
        : writeResponse(body),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* api
      .createIssue({ teamKey: "ENG", title: "Bug", body: "", labels: [], assignees: [] })
      .pipe(Effect.flip);
    assert.strictEqual(error.operation, "createIssue");
  }).pipe(Effect.provide(layer));
});

it.effect("edits only supplied issue fields and reports rejected writes", () => {
  let accepted = true;
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({ data: { issueUpdate: { success: accepted } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.updateIssue({ identifier: "ENG-7", title: "New title" });
    yield* api.updateIssue({ identifier: "ENG-7", body: "" });
    assert.deepStrictEqual(
      requests.map((request) => request.body.variables),
      [
        { id: "ENG-7", input: { title: "New title" } },
        { id: "ENG-7", input: { description: "" } },
      ],
    );
    accepted = false;
    const error = yield* api
      .updateIssue({ identifier: "ENG-7", title: "Rejected" })
      .pipe(Effect.flip);
    assert.strictEqual(error.operation, "updateIssue");
  }).pipe(Effect.provide(layer));
});

it.effect("replaces and clears labels without applying another team's labels", () => {
  const { layer, requests } = makeLayer({ envToken: "test-key", response: writeResponse });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Bug", "Bug"] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: ["team-bug"] },
    });
    const labelRead = requests.find((request) =>
      String(request.body.query).includes("T3LinearLabels"),
    )!;
    assert.deepStrictEqual(labelRead.body.variables, {
      filter: {
        or: [{ team: { id: { in: ["team-eng"] } } }, { team: { null: true } }],
        isGroup: { eq: false },
        name: { in: ["Bug", "Bug"] },
      },
    });
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: [] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: [] },
    });
    const count = requests.filter((request) =>
      String(request.body.query).includes("T3LinearIssueUpdate"),
    ).length;
    const error = yield* api
      .setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Other team's label"] })
      .pipe(Effect.flip);
    assert.strictEqual(error.writeRejection, "label-unavailable");
    assert.strictEqual(
      requests.filter((request) => String(request.body.query).includes("T3LinearIssueUpdate"))
        .length,
      count,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("assigns an active team member, clears with null, and refuses outsiders", () => {
  const { layer, requests } = makeLayer({ envToken: "test-key", response: writeResponse });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setAssignees({ teamKey: "ENG", identifier: "ENG-7", assignees: ["user-1"] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { assigneeId: "user-1" },
    });
    assert.deepStrictEqual(
      requests.find((request) => String(request.body.query).includes("T3LinearMembers"))?.body
        .variables,
      {
        id: "team-eng",
        filter: { active: { eq: true }, id: { in: ["user-1"] } },
      },
    );
    yield* api.setAssignees({ teamKey: "ENG", identifier: "ENG-7", assignees: [] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { assigneeId: null },
    });
    const error = yield* api
      .setAssignees({ teamKey: "ENG", identifier: "ENG-7", assignees: ["outsider"] })
      .pipe(Effect.flip);
    assert.strictEqual(error.writeRejection, "assignee-unavailable");
    const count = requests.length;
    const multiple = yield* api
      .setAssignees({ teamKey: "ENG", identifier: "ENG-7", assignees: ["user-1", "user-2"] })
      .pipe(Effect.flip);
    const create = yield* api
      .createIssue({
        teamKey: "ENG",
        title: "Bug",
        body: "",
        labels: [],
        assignees: ["user-1", "user-2"],
      })
      .pipe(Effect.flip);
    assert.strictEqual(multiple.writeRejection, "too-many-assignees");
    assert.strictEqual(create.writeRejection, "too-many-assignees");
    assert.strictEqual(requests.length, count);
  }).pipe(Effect.provide(layer));
});

it.effect.each([[], [{ ...WRITE_TEAM, key: "OTHER" }]])(
  "rejects an unavailable or mismatched team %j before writing",
  (nodes) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () => ({ data: { teams: { nodes } } }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const error = yield* api
        .createIssue({ teamKey: "ENG", title: "Bug", body: "", labels: [], assignees: [] })
        .pipe(Effect.flip);
      assert.strictEqual(error.writeRejection, "team-unavailable");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  ["close", undefined, "done"],
  ["close", "completed", "done"],
  ["close", "not-planned", "canceled"],
  ["reopen", undefined, "backlog"],
] as const)(
  "maps action %s reason %s to the team's workflow state",
  ([action, reason, stateId]) => {
    const { layer, requests } = makeLayer({ envToken: "test-key", response: writeResponse });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      yield* api.runAction({
        teamKey: "ENG",
        identifier: "ENG-7",
        action,
        ...(reason === undefined ? {} : { reason }),
      });
      assert.deepStrictEqual(requests.at(-1)?.body.variables, { id: "ENG-7", input: { stateId } });
      assert.strictEqual(
        (
          requests.find((request) => String(request.body.query).includes("T3LinearStates"))!.body
            .variables as { id: string }
        ).id,
        "team-eng",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("pages workflow states and fails when no matching state exists", () => {
  let available = true;
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      if (!String(body.query).includes("T3LinearStates")) return writeResponse(body);
      const { after } = body.variables as { after?: string };
      return {
        data: {
          team: {
            defaultIssueState: null,
            states: {
              nodes: after === undefined ? [WRITE_STATES[3]] : available ? [WRITE_STATES[2]] : [],
              pageInfo:
                after === undefined ? { hasNextPage: true, endCursor: "state-page" } : LAST_PAGE,
            },
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.runAction({ teamKey: "ENG", identifier: "ENG-7", action: "close" });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { stateId: "done" },
    });
    available = false;
    const error = yield* api
      .runAction({ teamKey: "ENG", identifier: "ENG-7", action: "close" })
      .pipe(Effect.flip);
    assert.strictEqual(error.writeRejection, "state-unavailable");
    yield* api.runAction({ teamKey: "ENG", identifier: "ENG-7", action: "reopen" });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { stateId: "todo" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  ["user-1", "ENG-7", undefined],
  ["other-user", "ENG-7", "not-comment-owner"],
  [null, "ENG-7", "not-comment-owner"],
  ["user-1", "OTHER-7", "wrong-comment-issue"],
] as const)(
  "checks comment owner %s and issue %s before editing",
  ([owner, identifier, rejection]) => {
    const { layer, requests } = makeLayer({
      credentials: pool(["account-1", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearCommentOwner")
          ? {
              data: {
                viewer: { id: "user-1" },
                comment: { user: owner === null ? null : { id: owner }, issue: { identifier } },
              },
            }
          : { data: { commentUpdate: { success: true } } },
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const edit = api.updateComment({
        identifier: "ENG-7",
        commentId: "comment-1",
        body: "  New body\n",
        credentialId: "account-1",
      });
      if (rejection === undefined) {
        yield* edit;
        assert.deepStrictEqual(requests.at(-1)?.body.variables, {
          id: "comment-1",
          input: { body: "  New body\n" },
        });
      } else {
        const error = yield* edit.pipe(Effect.flip);
        assert.strictEqual(error.writeRejection, rejection);
        assert.strictEqual(requests.length, 1);
      }
      assert.isTrue(requests.every((request) => request.authorization === "saved-key"));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("pages team candidates, merges workspace labels, and bounds long member lists", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      const { after } = body.variables as { after?: string };
      if (query.includes("T3LinearLabels"))
        return {
          data: {
            issueLabels: {
              nodes:
                after === undefined
                  ? [
                      WRITE_LABELS[0],
                      {
                        ...WRITE_LABELS[2],
                        team: { id: "team-other", key: "OTHER", name: "Other" },
                      },
                    ]
                  : [WRITE_LABELS[1], WRITE_LABELS[2]],
              pageInfo:
                after === undefined ? { hasNextPage: true, endCursor: "label-page" } : LAST_PAGE,
            },
          },
        };
      if (query.includes("T3LinearMembers")) {
        const page = Number(after ?? 0);
        return {
          data: {
            team: {
              members: {
                nodes: [{ id: `member-${page}` }],
                pageInfo: { hasNextPage: true, endCursor: String(page + 1) },
              },
            },
          },
        };
      }
      return writeResponse(body);
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const labels = yield* api.listLabels({ teamKey: "ENG" });
    assert.deepStrictEqual(
      labels.nodes.map((label) => [label.name, label.id]),
      [
        ["Bug", "team-bug"],
        ["Shared", "global"],
      ],
    );
    assert.isFalse(labels.truncated);
    const members = yield* api.listAssignees({ teamKey: "ENG" });
    assert.deepStrictEqual(
      members.nodes.map((user) => user.id),
      ["member-0", "member-1", "member-2", "member-3"],
    );
    assert.isTrue(members.truncated);
    assert.strictEqual(
      requests.filter((request) => String(request.body.query).includes("T3LinearMembers")).length,
      4,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("maps plain team and workspace templates using native content and JSON defaults", () => {
  const template = {
    id: "bug-template",
    name: "Bug report",
    description: "About the template",
    content: "## Steps\n",
    type: "issue",
    hasFormFields: false,
    templateData: JSON.stringify({
      title: "Bug: ",
      description: "Old body",
      labelIds: ["team-bug"],
      assigneeId: "user-1",
    }),
  };
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("T3LinearTeamTemplates")) {
        const { after } = body.variables as { after?: string };
        return {
          data: {
            source: {
              templates: {
                nodes:
                  after === undefined
                    ? [template]
                    : [
                        {
                          ...template,
                          id: "a5d0d1ec-922e-4d76-8bc2-897067a6ac67",
                          hasFormFields: true,
                        },
                        {
                          ...template,
                          id: "structured",
                          content: null,
                          templateData: JSON.stringify({
                            descriptionData: { type: "doc", content: [{ type: "unknown" }] },
                          }),
                        },
                      ],
                pageInfo:
                  after === undefined
                    ? { hasNextPage: true, endCursor: "templates-page" }
                    : LAST_PAGE,
              },
            },
          },
        };
      }
      if (query.includes("T3LinearWorkspaceTemplates"))
        return {
          data: {
            source: {
              templates: {
                nodes: [
                  {
                    ...template,
                    id: "workspace-template",
                    content: null,
                    templateData: { title: "Task", description: "Body draft" },
                  },
                  { ...template, id: "project-template", type: "project" },
                  {
                    ...template,
                    id: "rich-description",
                    content: null,
                    templateData: { description: { type: "doc", content: [] } },
                  },
                ],
                pageInfo: LAST_PAGE,
              },
            },
          },
        };
      return writeResponse(body);
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const offer = yield* api.getIssueTemplates({ teamKey: "ENG" });
    assert.deepStrictEqual(offer, {
      templates: [
        {
          key: "bug-template",
          name: "Bug report",
          about: "About the template",
          title: "Bug: ",
          body: "## Steps\n",
          labels: ["Bug"],
          assignees: ["user-1"],
        },
        {
          key: "workspace-template",
          name: "Bug report",
          about: "About the template",
          title: "Task",
          body: "Body draft",
          labels: [],
          assignees: [],
        },
      ],
      contactLinks: [
        {
          name: "Bug report",
          about: "About the template",
          url: "https://linear.app/team/ENG/new?template=a5d0d1ec-922e-4d76-8bc2-897067a6ac67",
        },
        {
          name: "Bug report",
          about: "About the template",
          url: "https://linear.app/team/ENG/new?template=structured",
        },
        {
          name: "Bug report",
          about: "About the template",
          url: "https://linear.app/team/ENG/new?template=rich-description",
        },
      ],
      blankIssuesEnabled: true,
    });
    assert.strictEqual(requests.length, 5);
    assert.deepStrictEqual(
      requests
        .filter((request) => String(request.body.query).includes("T3LinearTeamTemplates"))
        .map((request) => request.body.variables),
      [{ id: "team-eng" }, { id: "team-eng", after: "templates-page" }],
    );
    const created = yield* api.createIssue({
      teamKey: "ENG",
      title: offer.templates[0]!.title,
      body: offer.templates[0]!.body,
      labels: offer.templates[0]!.labels,
      assignees: offer.templates[0]!.assignees,
    });
    assert.strictEqual(created.number, 12);
    assert.deepStrictEqual((requests.at(-1)!.body.variables as { input: unknown }).input, {
      teamId: "team-eng",
      title: "Bug: ",
      description: "## Steps\n",
      labelIds: ["team-bug"],
      assigneeId: "user-1",
      useDefaultTemplate: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each(["missing-label", "workspace-bug"])(
  "does not invent missing or ambiguous template label defaults %s",
  (labelId) => {
    const { layer } = makeLayer({
      envToken: "test-key",
      response: (body) =>
        String(body.query).includes("Templates")
          ? {
              data: {
                source: {
                  templates: {
                    nodes: [
                      {
                        id: "t",
                        name: "Template",
                        description: null,
                        content: null,
                        type: "issue",
                        hasFormFields: false,
                        templateData: JSON.stringify({ labelIds: [labelId] }),
                      },
                    ],
                    pageInfo: LAST_PAGE,
                  },
                },
              },
            }
          : writeResponse(body),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const error = yield* api.getIssueTemplates({ teamKey: "ENG" }).pipe(Effect.flip);
      assert.strictEqual(error.writeRejection, "incomplete-templates");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("pages native history and preserves system actors and workflow details", () => {
  const history = Array.from({ length: 51 }, (_, index) => ({
    id: `history-${index}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    actor: index === 0 ? null : { id: "user-1" },
    fromState: { name: "Doing", type: "started" },
    toState: { name: "Done", type: "completed" },
    fromAssignee: null,
    toAssignee: null,
    addedLabels: null,
    removedLabels: null,
    fromTitle: null,
    toTitle: null,
  }));
  const { layer, requests } = makeLayer({
    credentials: pool(["account-1", "saved-key"]),
    response: (body) => {
      const { after } = body.variables as { after?: string };
      return {
        data: {
          issue: {
            history: {
              nodes: after === undefined ? history.slice(0, 50) : history.slice(50),
              pageInfo:
                after === undefined ? { hasNextPage: true, endCursor: "history-page" } : LAST_PAGE,
            },
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const read = yield* api.getHistory({ identifier: "ENG-7", credentialId: "account-1" });
    assert.deepStrictEqual(read, {
      nodes: history.slice(0, 50),
      truncated: true,
      nextCursor: "history-page",
    });
    assert.strictEqual(requests.length, 1);
    const next = yield* api.getHistory({
      identifier: "ENG-7",
      credentialId: "account-1",
      cursor: read.nextCursor!,
    });
    assert.deepStrictEqual(next, { nodes: history.slice(50), truncated: false, nextCursor: null });
    assert.deepStrictEqual(
      requests.map((request) => request.body.variables),
      [{ id: "ENG-7" }, { id: "ENG-7", after: "history-page" }],
    );
    assert.isTrue(
      requests.every((request) => {
        const query = String(request.body.query);
        return (
          query.includes("history(first: 50, after: $after") &&
          !query.includes("comments") &&
          !query.includes("attachments") &&
          !query.includes("viewer")
        );
      }),
    );
    assert.isTrue(requests.every((request) => request.authorization === "saved-key"));
  }).pipe(Effect.provide(layer));
});

it.effect.each([null, "", "   ", "current"])(
  "rejects a missing, malformed, or repeated history continuation %s",
  (endCursor) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () => ({
        data: { issue: { history: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } } },
      }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const error = yield* api
        .getHistory({ identifier: "ENG-7", cursor: "current" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.strictEqual(error.operation, "issue history cursor");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["", "   "])("rejects an empty history cursor before a request %s", (cursor) => {
  const { layer, requests } = makeLayer({ envToken: "test-key", response: () => ({}) });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* api.getHistory({ identifier: "ENG-7", cursor }).pipe(Effect.flip);
    assert.strictEqual(error.operation, "issue history cursor");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["history", "attachments"] as const)(
  "%s continuation shares issue endpoint pauses without retrying HTTP 429",
  (kind) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () =>
        Response.json(
          {},
          {
            status: 429,
            headers: {
              "X-RateLimit-Endpoint-Name": "issue",
              "X-RateLimit-Endpoint-Requests-Remaining": "0",
              "X-RateLimit-Endpoint-Requests-Reset": "61000",
              "Retry-After": "60",
            },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      const reference = { identifier: "ENG-7", cursor: "page-50" };
      const read = () =>
        kind === "history"
          ? api.getHistory(reference).pipe(Effect.flip)
          : api.getAttachments(reference).pipe(Effect.flip);
      const first = yield* read();
      const next = yield* read();
      const detail = yield* api.getIssue({ identifier: "ENG-7" }).pipe(Effect.flip);
      for (const error of [first, next, detail]) {
        assert.strictEqual(error.reason, "rate-limited");
        assert.strictEqual(error.retryAt, 61000);
      }
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("new writes share account-wide and mutation endpoint quota pauses", () => {
  let paused = false;
  const { layer, requests } = makeLayer({
    envToken: "environment-key",
    credentials: pool(["saved", "saved-key"]),
    response: (body) => {
      const query = String(body.query);
      if (query.includes("T3LinearViewer")) return { data: { viewer: { id: "user-1" } } };
      if (query.includes("T3LinearIssueUpdate") && !paused) {
        paused = true;
        return Response.json(
          {},
          {
            status: 429,
            headers: {
              "X-RateLimit-Requests-Remaining": "0",
              "X-RateLimit-Requests-Reset": "61000",
              "X-RateLimit-Endpoint-Name": "issueUpdate",
              "X-RateLimit-Endpoint-Requests-Remaining": "0",
              "X-RateLimit-Endpoint-Requests-Reset": "121000",
            },
          },
        );
      }
      return writeResponse(body);
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    yield* api.getViewer({ credentialId: "saved" });
    const first = yield* api.updateIssue({ identifier: "ENG-7", title: "Pause" }).pipe(Effect.flip);
    assert.strictEqual(first.retryAt, 121000);
    const global = yield* api
      .createIssue({
        teamKey: "ENG",
        title: "Blocked",
        body: "",
        labels: [],
        assignees: [],
        credentialId: "saved",
      })
      .pipe(Effect.flip);
    assert.strictEqual(global.retryAt, 61000);
    assert.strictEqual(requests.length, 3);
    yield* TestClock.setTime(62000);
    const endpoint = yield* api
      .updateIssue({ identifier: "ENG-7", body: "Blocked", credentialId: "saved" })
      .pipe(Effect.flip);
    assert.strictEqual(endpoint.retryAt, 121000);
    assert.strictEqual(requests.length, 3);
    yield* api.createIssue({
      teamKey: "ENG",
      title: "Allowed",
      body: "",
      labels: [],
      assignees: [],
      credentialId: "saved",
    });
    yield* TestClock.setTime(122000);
    yield* api.updateIssue({ identifier: "ENG-7", body: "Allowed", credentialId: "saved" });
  }).pipe(Effect.provide(layer));
});

it.effect("reserves new mutation complexity before dispatching HTTP", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        { data: { viewer: { id: "user-1" } } },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "10",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    const error = yield* api
      .updateIssue({ identifier: "ENG-7", title: "Too expensive" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "rate-limited");
    assert.strictEqual(error.retryAt, 61000);
    assert.strictEqual(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("returns one history page and its exact native continuation", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const { after } = body.variables as { after?: string };
      const page = Number(after ?? 0);
      return {
        data: {
          issue: {
            history: {
              nodes: [
                {
                  id: `history-${page}`,
                  createdAt: "2026-10-01T00:00:00.000Z",
                  actor: null,
                  fromState: null,
                  toState: null,
                  fromAssignee: null,
                  toAssignee: null,
                  addedLabels: null,
                  removedLabels: null,
                  fromTitle: null,
                  toTitle: null,
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: String(page + 1) },
            },
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const history = yield* api.getHistory({ identifier: "ENG-7" });
    assert.strictEqual(history.nodes.length, 1);
    assert.isTrue(history.truncated);
    assert.strictEqual(history.nextCursor, "1");
    assert.strictEqual(requests.length, 1);
    assert.isTrue(
      requests.every((request) => String(request.body.query).includes("history(first: 50,")),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("retains current label IDs and resolves only added names", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) =>
      String(body.query).includes("T3LinearSelection")
        ? {
            data: {
              issue: {
                id: "issue-7",
                assignee: null,
                labels: {
                  nodes: [
                    { id: "workspace-bug", name: "Bug" },
                    ...(String(body.query).includes("includeArchived: true")
                      ? [{ id: "archived", name: "Old" }]
                      : []),
                  ],
                  pageInfo: LAST_PAGE,
                },
              },
            },
          }
        : writeResponse(body),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Bug", "Old", "Shared"] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: ["workspace-bug", "archived", "global"] },
    });
    assert.deepStrictEqual(
      (
        requests.find((r) => String(r.body.query).includes("T3LinearLabels"))!.body.variables as {
          filter: { name: unknown };
        }
      ).filter.name,
      { in: ["Shared"] },
    );
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Bug"] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: ["workspace-bug"] },
    });
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: [] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: [] },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects label writes before choosing IDs from an incomplete native lookup", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      if (!String(body.query).includes("T3LinearLabels")) return writeResponse(body);
      const page = Number((body.variables as { after?: string }).after ?? 0);
      return {
        data: {
          issueLabels: {
            nodes: [WRITE_LABELS[page === 4 ? 1 : 0]],
            pageInfo: { hasNextPage: page < 4, endCursor: String(page + 1) },
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    for (const write of [
      api.createIssue({ teamKey: "ENG", title: "Bug", body: "", labels: ["Bug"], assignees: [] }),
      api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Bug"] }),
    ]) {
      const error = yield* write.pipe(Effect.flip);
      assert.strictEqual(error.writeRejection, "label-unavailable");
    }
    assert.strictEqual(
      requests.filter((request) => String(request.body.query).includes("T3LinearLabels")).length,
      8,
    );
    assert(!requests.some((request) => String(request.body.query).includes("mutation")));
  }).pipe(Effect.provide(layer));
});

it.effect("uses ancestor labels and templates while excluding unrelated teams", () => {
  const parent = { id: "parent-team", key: "PARENT", name: "Parent" };
  const root = { id: "root-team", key: "ROOT", name: "Root" };
  const inherited = [parent, root].map((team) => ({
    id: `${team.id}-label`,
    name: team.name,
    color: "#000000",
    description: null,
    team,
  }));
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      const variables = body.variables as { id?: string; filter?: { name?: { in: string[] } } };
      if (query.includes("T3LinearTeam("))
        return { data: { teams: { nodes: [{ ...WRITE_TEAM, ancestors: [root, parent] }] } } };
      if (query.includes("T3LinearLabels"))
        return {
          data: {
            issueLabels: {
              nodes: [
                ...inherited,
                {
                  ...inherited[0],
                  id: "outside",
                  name: "Outside",
                  team: { id: "other", key: "OTHER", name: "Other" },
                },
              ].filter(
                (label) => !variables.filter?.name || variables.filter.name.in.includes(label.name),
              ),
              pageInfo: LAST_PAGE,
            },
          },
        };
      if (query.includes("T3LinearTeamTemplates") || query.includes("T3LinearWorkspaceTemplates"))
        return {
          data: {
            source: {
              templates: {
                nodes:
                  variables.id === parent.id
                    ? [
                        {
                          id: "inherited-template",
                          name: "Parent template",
                          description: null,
                          content: "Body",
                          type: "issue",
                          hasFormFields: false,
                          templateData: { labelIds: [inherited[0]!.id] },
                        },
                        {
                          id: "inherited-form",
                          name: "Parent form",
                          description: null,
                          content: null,
                          type: "issue",
                          hasFormFields: true,
                          templateData: {},
                        },
                      ]
                    : query.includes("T3LinearWorkspaceTemplates")
                      ? [
                          {
                            id: "workspace-rich&template=other#fragment",
                            name: "Workspace rich template",
                            description: null,
                            content: null,
                            type: "issue",
                            hasFormFields: false,
                            templateData: { descriptionData: { type: "doc" } },
                          },
                        ]
                      : [],
                pageInfo: LAST_PAGE,
              },
            },
          },
        };
      return writeResponse(body);
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(
      (yield* api.listLabels({ teamKey: "ENG" })).nodes.map((label) => label.id),
      inherited.map((label) => label.id),
    );
    const filter = (requests.at(-1)!.body.variables as { filter: { or: unknown } }).filter;
    assert.deepStrictEqual(filter.or, [
      { team: { id: { in: ["team-eng", "parent-team", "root-team"] } } },
      { team: { null: true } },
    ]);
    yield* api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Parent", "Root"] });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { labelIds: inherited.map((label) => label.id) },
    });
    const templates = yield* api.getIssueTemplates({ teamKey: "ENG" });
    assert.deepStrictEqual(
      templates.templates.map((t) => [t.key, t.labels]),
      [["inherited-template", ["Parent"]]],
    );
    assert.deepStrictEqual(templates.contactLinks, [
      {
        name: "Parent form",
        about: "",
        url: "https://linear.app/team/ENG/new?template=inherited-form",
      },
      {
        name: "Workspace rich template",
        about: "",
        url: "https://linear.app/team/ENG/new?template=workspace-rich%26template%3Dother%23fragment",
      },
    ]);
    const workspaceUrl = new URL(templates.contactLinks[1]!.url);
    assert.strictEqual(
      workspaceUrl.searchParams.get("template"),
      "workspace-rich&template=other#fragment",
    );
    assert.strictEqual(workspaceUrl.hash, "");
    assert.deepStrictEqual(
      requests
        .filter((request) => String(request.body.query).includes("Templates"))
        .map((request) => request.body.variables),
      [{ id: "team-eng" }, { id: "root-team" }, { id: "parent-team" }, {}],
    );
    yield* api.createIssue({
      teamKey: "ENG",
      title: "Parent template",
      body: "Body",
      labels: templates.templates[0]!.labels,
      assignees: [],
    });
    assert.deepStrictEqual(
      (requests.at(-1)!.body.variables as { input: { labelIds: unknown } }).input.labelIds,
      [inherited[0]!.id],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("resolves exact team-member email for create and assignment", () => {
  const { layer, requests } = makeLayer({ envToken: "test-key", response: writeResponse });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.createIssue({
      teamKey: "ENG",
      title: "Email",
      body: "",
      labels: [],
      assignees: ["ada@example.com"],
    });
    assert.strictEqual(
      (requests.at(-1)!.body.variables as { input: { assigneeId: string } }).input.assigneeId,
      "user-1",
    );
    yield* api.setAssignees({
      teamKey: "ENG",
      identifier: "ENG-7",
      assignees: ["ada@example.com"],
    });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, {
      id: "ENG-7",
      input: { assigneeId: "user-1" },
    });
    assert.deepStrictEqual(
      requests.find((r) => String(r.body.query).includes("T3LinearMembers"))?.body.variables,
      {
        id: "team-eng",
        filter: { active: { eq: true }, email: { eq: "ada@example.com" } },
      },
    );
    for (const email of ["unknown@example.com", "otherteam@example.com", "Ada"]) {
      const count = requests.filter((r) => String(r.body.query).startsWith("mutation")).length;
      const create = yield* api
        .createIssue({
          teamKey: "ENG",
          title: "Rejected",
          body: "",
          labels: [],
          assignees: [email],
        })
        .pipe(Effect.flip);
      const assign = yield* api
        .setAssignees({ teamKey: "ENG", identifier: "ENG-7", assignees: [email] })
        .pipe(Effect.flip);
      assert.strictEqual(create.writeRejection, "assignee-unavailable");
      assert.strictEqual(assign.writeRejection, "assignee-unavailable");
      assert.strictEqual(
        requests.filter((r) => String(r.body.query).startsWith("mutation")).length,
        count,
      );
    }
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "retains paged issue labels and refuses incomplete reads truncated=%s",
  (truncated) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: (body) => {
        if (!String(body.query).includes("T3LinearSelection")) return writeResponse(body);
        const { after } = body.variables as { after?: string };
        const page = Number(after ?? 0);
        return {
          data: {
            issue: {
              id: "issue-7",
              assignee: null,
              labels: {
                nodes: [{ id: `archived-${page}`, name: "Old" }],
                pageInfo:
                  truncated || page === 0
                    ? { hasNextPage: true, endCursor: String(page + 1) }
                    : LAST_PAGE,
              },
            },
          },
        };
      },
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const update = api.setLabels({ teamKey: "ENG", identifier: "ENG-7", labels: ["Old"] });
      if (truncated) {
        const error = yield* update.pipe(Effect.flip);
        assert.strictEqual(error.writeRejection, "label-unavailable");
        assert.isFalse(requests.some((r) => String(r.body.query).includes("T3LinearIssueUpdate")));
      } else {
        yield* update;
        assert.deepStrictEqual(requests.at(-1)?.body.variables, {
          id: "ENG-7",
          input: { labelIds: ["archived-0", "archived-1"] },
        });
        assert.isFalse(requests.some((r) => String(r.body.query).includes("T3LinearLabels")));
      }
      assert.strictEqual(
        requests.filter((r) => String(r.body.query).includes("T3LinearSelection")).length,
        truncated ? 4 : 2,
      );
    }).pipe(Effect.provide(layer));
  },
);
