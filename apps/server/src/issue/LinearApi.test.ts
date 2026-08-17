import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeSync(Json);
const pool = (...credentials: ReadonlyArray<readonly [credentialId: string, token: string]>) =>
  encodeJson({
    version: 1,
    credentials: credentials.map(([credentialId, token]) => ({ credentialId, token })),
  });

function memorySecrets(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, Uint8Array>();
  for (const [name, value] of Object.entries(initial)) values.set(name, bytes(value));
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      return Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(value);
      });
    },
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
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
  readonly token?: string;
  readonly credentials?: string;
  readonly response: (body: Record<string, unknown>, authorization: string | undefined) => unknown;
}) {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  const secrets = memorySecrets({
    ...(input.token === undefined ? {} : { [LinearApi.LINEAR_API_TOKEN_SECRET]: input.token }),
    ...(input.credentials === undefined ? {} : { "linear.credentials": input.credentials }),
  });
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const raw = (request.body as { readonly body?: Uint8Array }).body;
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const authorization = request.headers.authorization;
    requests.push({ body, authorization });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(input.response(body, authorization))),
    );
  });
  const layer = LinearApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_LINEAR_API_BASE_URL: "https://linear.test" } }),
      ),
    ),
  );
  return { layer, requests, values: secrets.values };
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
      teams: [],
      accounts: [],
    });
    assert.strictEqual(response.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("migrates the legacy token after it has been verified", () => {
  const { layer, values } = makeLayer({
    token: "lin_api_test",
    response: () => ({
      data: {
        viewer: { id: "user-1", name: "Ada", email: "ada@example.com" },
        teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.connection, {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
      accounts: [
        {
          credentialId: "user-1",
          status: "authenticated",
          accountName: "Ada",
          accountEmail: "ada@example.com",
          teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
      ],
    });
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_test"])),
    );
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
  }).pipe(Effect.provide(layer));
});

it.effect("probes a new key before appending a second saved account", () => {
  let values: Map<string, Uint8Array>;
  let newKeyProbed = false;
  const test = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      if (authorization === "lin_api_two" && !newKeyProbed) {
        assert.deepStrictEqual(
          decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
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
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(test.layer));
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
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it("clears every project binding for a disconnected account", () => {
  assert.deepStrictEqual(
    LinearApi.clearCredentialBindings(
      {
        project_1: { credentialId: "user-1", teamKey: "ENG" },
        project_2: { credentialId: "user-2", teamKey: "OPS" },
        project_3: { credentialId: "user-1", teamKey: "MOBILE" },
      },
      "user-1",
    ),
    {
      project_1: null,
      project_2: { credentialId: "user-2", teamKey: "OPS" },
      project_3: null,
    },
  );
});

it.effect("loads Linear activity reactions from API arrays", () => {
  const { layer } = makeLayer({
    token: "lin_api_test",
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
      ],
      reactions: [{ id: "reaction-2", emoji: "🎉", user: { id: "user-2" } }],
      commentsTruncated: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates and removes Linear issue reactions", () => {
  const { layer, requests } = makeLayer({
    token: "lin_api_test",
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
    token: "lin_api_test",
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
