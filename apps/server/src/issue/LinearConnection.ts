import type {
  LinearConnection,
  LinearDisconnectInput,
  LinearProjectBinding,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";

const coordinatorMutex = Semaphore.makeUnsafe(1);

export function clearCredentialBindings(
  bindings: Readonly<Record<string, LinearProjectBinding | null>>,
  credentialId: string,
): Record<string, null> {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([projectId, binding]) =>
      binding?.credentialId === credentialId ? [[projectId, null]] : [],
    ),
  );
}

const syncLegacyBindings = (connection: LinearConnection) =>
  Effect.gen(function* () {
    const account = connection.accounts.length === 1 ? connection.accounts[0] : undefined;
    if (account === undefined) return connection;

    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings;
    const additions = Object.fromEntries(
      Object.entries(current.issueTracking.linear.projectTeams).flatMap(([projectId, teamKey]) =>
        current.issueTracking.linear.projectBindings[projectId as ProjectId] === undefined
          ? [[projectId, { credentialId: account.credentialId, teamKey }]]
          : [],
      ),
    );
    if (Object.keys(additions).length === 0) return connection;

    yield* settings.updateSettings({
      issueTracking: { linear: { projectBindings: additions } },
    });
    return connection;
  });

export const linearConnectionStatus = coordinatorMutex.withPermits(1)(
  Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    return yield* syncLegacyBindings(yield* linear.connection);
  }),
);

export const connectLinearAccount = (token: string) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      yield* syncLegacyBindings(yield* linear.connection);
      return yield* syncLegacyBindings(yield* linear.connect(token));
    }),
  );

export const disconnectLinearAccount = (input: LinearDisconnectInput) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      if (input === undefined && connection.accounts.length === 0) {
        return yield* linear.disconnect(undefined);
      }
      const credentialId =
        input?.credentialId ??
        (connection.accounts.length === 1 ? connection.accounts[0]?.credentialId : undefined);
      if (credentialId === undefined) {
        return yield* new LinearApi.LinearApiError({
          reason: "failed",
          detail: "Choose the Linear account to disconnect.",
        });
      }

      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      const removals = clearCredentialBindings(
        current.issueTracking.linear.projectBindings,
        credentialId,
      );
      if (Object.keys(removals).length > 0) {
        yield* settings.updateSettings({
          issueTracking: { linear: { projectBindings: removals } },
        });
      }
      return yield* linear.disconnect({ credentialId });
    }),
  );
