import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ProjectId, ServerSettingsError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import {
  clearCredentialBindings,
  connectLinearAccount,
  disconnectLinearAccount,
  linearConnectionStatus,
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

it.effect("passes an old disconnect call through when only an invalid legacy key remains", () => {
  let legacyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection(),
      status: "unauthenticated",
      hasStoredToken: true,
    }),
    disconnect: (input: undefined | { readonly credentialId: string }) =>
      input === undefined
        ? Effect.sync(() => {
            legacyStored = false;
            return connection();
          })
        : Effect.die("must disconnect the unverified legacy key"),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);
    assert.isFalse(legacyStored);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});

it.effect("serializes legacy binding migration with disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const migrationStarted = yield* Deferred.make<void>();
      const releaseMigration = yield* Deferred.make<void>();
      let connected = true;
      let current = {
        ...DEFAULT_SERVER_SETTINGS,
        issueTracking: {
          linear: {
            ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
            projectTeams: { [PROJECT_ID]: "ENG" },
            projectBindings: {} as Record<
              ProjectId,
              null | { readonly credentialId: string; readonly teamKey: string }
            >,
          },
        },
      };
      const api = LinearApi.LinearApi.of({
        connection: Effect.sync(() => (connected ? connection("user-1") : connection())),
        disconnect: () =>
          Effect.sync(() => {
            connected = false;
            return connection();
          }),
      } as unknown as LinearApi.LinearApi["Service"]);
      const settings = ServerSettings.ServerSettingsService.of({
        getSettings: Effect.sync(() => current),
        updateSettings: (patch: {
          readonly issueTracking?: {
            readonly linear?: {
              readonly projectBindings?: Readonly<
                Record<
                  ProjectId,
                  null | { readonly credentialId: string; readonly teamKey: string }
                >
              >;
            };
          };
        }) =>
          Effect.gen(function* () {
            const binding = patch.issueTracking?.linear?.projectBindings?.[PROJECT_ID];
            if (binding !== undefined && binding !== null) {
              yield* Deferred.succeed(migrationStarted, undefined);
              yield* Deferred.await(releaseMigration);
            }
            current = {
              ...current,
              issueTracking: {
                linear: {
                  ...current.issueTracking.linear,
                  projectBindings: {
                    ...current.issueTracking.linear.projectBindings,
                    ...(binding === undefined ? {} : { [PROJECT_ID]: binding }),
                  },
                },
              },
            };
            return current;
          }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]);
      const layer = Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
      );
      const migration = yield* linearConnectionStatus.pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(migrationStarted);
      const disconnect = yield* disconnectLinearAccount(undefined).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.isTrue(connected);

      yield* Deferred.succeed(releaseMigration, undefined);
      yield* Fiber.join(migration);
      yield* Fiber.join(disconnect);
      assert.isNull(current.issueTracking.linear.projectBindings[PROJECT_ID]);
      assert.isFalse(connected);
    }),
  ),
);

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
