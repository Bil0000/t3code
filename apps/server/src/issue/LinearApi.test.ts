import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

function memorySecrets(initial?: string) {
  const values = new Map<string, Uint8Array>();
  if (initial !== undefined) values.set(LinearApi.LINEAR_API_TOKEN_SECRET, bytes(initial));
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      const value = values.get(name);
      return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
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
}

function makeLayer(input: {
  readonly token?: string;
  readonly response: (body: Record<string, unknown>) => unknown;
}) {
  const requests: Record<string, unknown>[] = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const raw = (request.body as { readonly body?: Uint8Array }).body;
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    requests.push(body);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(input.response(body))));
  });
  const layer = LinearApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, memorySecrets(input.token))),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_LINEAR_API_BASE_URL: "https://linear.test" } }),
      ),
    ),
  );
  return { layer, requests };
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
    });
    assert.strictEqual(response.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("returns the connected Linear account and teams", () => {
  const { layer } = makeLayer({
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
      return {
        data: {
          viewer: { id: "user-1" },
          issue: {
            reactions: { nodes: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }] },
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: true });
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: false });

    assert.deepStrictEqual((requests[0]?.variables as { input: unknown }).input, {
      issueId: "ENG-7",
      emoji: "👍",
    });
    assert.deepStrictEqual(requests.at(-1)?.variables, { id: "reaction-1" });
  }).pipe(Effect.provide(layer));
});
