import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ProjectId, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import {
  clearCredentialBindings,
  connectLinearAccount,
  disconnectLinearAccount,
} from "./LinearConnection.ts";

const account = (credentialId: string) => ({
  credentialId,
  status: "authenticated" as const,
  accountName: credentialId,
  accountEmail: null,
  teams: [],
});
const PROJECT_ID = "project_1" as ProjectId;

const connection = (...credentialIds: ReadonlyArray<string>) => ({
  status: credentialIds.length === 0 ? ("unauthenticated" as const) : ("authenticated" as const),
  hasStoredToken: credentialIds.length > 0,
  accountName: credentialIds[0] ?? null,
  accountEmail: null,
  teams: [],
  accounts: credentialIds.map(account),
});

it("emits tombstones only for bindings owned by the disconnected account", () => {
  assert.deepStrictEqual(
    clearCredentialBindings(
      {
        project_1: { credentialId: "user-1", teamKey: "ENG" },
        project_2: { credentialId: "user-2", teamKey: "OPS" },
        project_3: { credentialId: "user-1", teamKey: "MOBILE" },
      },
      "user-1",
    ),
    { project_1: null, project_3: null },
  );
});

it.effect("migrates a legacy project binding before appending a second account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    connect: () => Effect.succeed(connection("user-1", "user-2")),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* connectLinearAccount("lin_api_two");
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
        }),
      ),
    ),
  );
});

it.effect("keeps a key when clearing its project bindings fails", () => {
  let keyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    disconnect: () =>
      Effect.sync(() => {
        keyStored = false;
        return connection();
      }),
  } as unknown as LinearApi.LinearApi["Service"]);
  const settings = ServerSettings.ServerSettingsService.of({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      issueTracking: {
        linear: {
          ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
          projectBindings: { [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" } },
        },
      },
    }),
    updateSettings: () =>
      Effect.fail(
        new ServerSettingsError({ settingsPath: "test", operation: "write-file", cause: "test" }),
      ),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

  return Effect.gen(function* () {
    const result = yield* Effect.exit(disconnectLinearAccount(undefined));
    assert.isTrue(Exit.isFailure(result));
    assert.isTrue(keyStored);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
      ),
    ),
  );
});

it.effect("uses the only account for an old disconnect call without a payload", () => {
  let disconnected: string | undefined;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    disconnect: ({ credentialId }: { readonly credentialId: string }) => {
      disconnected = credentialId;
      return Effect.succeed(connection());
    },
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);
    assert.strictEqual(disconnected, "user-1");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});

it.effect("requires a credential for an old disconnect call when accounts are ambiguous", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1", "user-2")),
    disconnect: () => Effect.die("must not delete a key"),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(disconnectLinearAccount(undefined));
    assert.strictEqual(error._tag, "LinearApiError");
    if (error._tag === "LinearApiError") assert.match(error.detail, /choose.*account/i);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});
