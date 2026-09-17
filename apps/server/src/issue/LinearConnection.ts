import type {
  LinearDisconnectInput,
  LinearProjectBinding,
  LinearSetProjectBindingInput,
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

export const linearConnectionStatus = Effect.gen(function* () {
  const linear = yield* LinearApi.LinearApi;
  return yield* linear.connection;
});

export const connectLinearAccount = (token: string) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      return yield* linear.connect(token);
    }),
  );

export const setLinearProjectBinding = (input: LinearSetProjectBindingInput) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      const binding = input.binding;
      if (binding !== null && binding.credentialId !== undefined) {
        const account = connection.accounts.find(
          ({ credentialId }) => credentialId === binding.credentialId,
        );
        if (account === undefined) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "unknown-credential",
          });
        }
        if (account.status !== "authenticated") {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "account-unavailable",
          });
        }
        if (!account.teams.some(({ key }) => key === binding.teamKey)) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "team-unavailable",
          });
        }
      } else if (binding !== null) {
        const environmentAccount = connection.environmentAccount;
        if (
          environmentAccount?.status !== "authenticated" ||
          !environmentAccount.teams.some(({ key }) => key === binding.teamKey)
        ) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            teamKey: binding.teamKey,
            bindingRejection: "environment-account-unavailable",
          });
        }
      }

      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        issueTracking: { linear: { projectBindings: { [input.projectId]: binding } } },
      });
    }),
  );

export const disconnectLinearAccount = (input: LinearDisconnectInput) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      const credentialId =
        input?.credentialId ??
        (connection.accounts.length === 1 ? connection.accounts[0]?.credentialId : undefined);

      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      if (credentialId === undefined) {
        return yield* new LinearApi.LinearAccountSelectionRequiredError();
      }

      const removals = clearCredentialBindings(
        current.issueTracking.linear.projectBindings,
        credentialId,
      );
      const restorations = Object.fromEntries(
        Object.keys(removals).flatMap((projectId) => {
          const binding = current.issueTracking.linear.projectBindings[projectId as ProjectId];
          return binding === undefined ? [] : [[projectId, binding]];
        }),
      );
      if (Object.keys(removals).length > 0) {
        yield* settings.updateSettings({
          issueTracking: {
            linear: { projectBindings: removals },
          },
        });
      }
      return yield* linear.disconnect({ credentialId }).pipe(
        Effect.tapError(() =>
          Object.keys(restorations).length === 0
            ? Effect.void
            : settings.updateSettings({
                issueTracking: { linear: { projectBindings: restorations } },
              }),
        ),
      );
    }),
  );
