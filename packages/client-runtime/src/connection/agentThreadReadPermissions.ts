import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { gitHubRoutingConnectionKey } from "./githubRoutingPermissions.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

export const StoredAgentThreadReadGrant = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceConnectionKey: Schema.String,
  destinationEnvironmentId: EnvironmentId,
  destinationConnectionKey: Schema.String,
});
export type StoredAgentThreadReadGrant = typeof StoredAgentThreadReadGrant.Type;

export function agentThreadReadAllowed(
  source: ConnectionCatalogEntry,
  destination: ConnectionCatalogEntry,
  grants: ReadonlyArray<StoredAgentThreadReadGrant>,
): boolean {
  if (source.target.environmentId === destination.target.environmentId) return false;
  const sourceKey = gitHubRoutingConnectionKey(source);
  const destinationKey = gitHubRoutingConnectionKey(destination);
  return (
    sourceKey !== null &&
    destinationKey !== null &&
    grants.some(
      (grant) =>
        grant.sourceEnvironmentId === source.target.environmentId &&
        grant.destinationEnvironmentId === destination.target.environmentId &&
        grant.sourceConnectionKey === sourceKey &&
        grant.destinationConnectionKey === destinationKey,
    )
  );
}

export class AgentThreadReadPermissions extends Context.Reference<{
  readonly get: (
    source: ConnectionCatalogEntry,
    destination: ConnectionCatalogEntry,
  ) => Effect.Effect<boolean>;
  readonly changes: Stream.Stream<ReadonlyArray<StoredAgentThreadReadGrant>>;
  readonly set: (
    source: ConnectionCatalogEntry,
    destination: ConnectionCatalogEntry,
    allowed: boolean,
  ) => Effect.Effect<void, ConnectionAttemptError>;
  readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/AgentThreadReadPermissions", {
  defaultValue: () => ({
    get: () => Effect.succeed(false),
    changes: Stream.succeed([]),
    set: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Agent thread sharing is unavailable on this client.",
        }),
      ),
    forget: () => Effect.void,
  }),
}) {}

export const makeAgentThreadReadPermissions = Effect.fn("makeAgentThreadReadPermissions")(
  function* (storage: {
    readonly read: Effect.Effect<ReadonlyArray<StoredAgentThreadReadGrant>, ConnectionAttemptError>;
    readonly write: (
      grants: ReadonlyArray<StoredAgentThreadReadGrant>,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }) {
    const state = yield* SubscriptionRef.make(yield* storage.read);
    const lock = yield* Semaphore.make(1);
    const update = (
      transform: (
        grants: ReadonlyArray<StoredAgentThreadReadGrant>,
      ) => ReadonlyArray<StoredAgentThreadReadGrant>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const next = transform(current);
          yield* storage.write(next);
          yield* SubscriptionRef.set(state, next);
        }),
      );
    return AgentThreadReadPermissions.of({
      get: (source, destination) =>
        SubscriptionRef.get(state).pipe(
          Effect.map((grants) => agentThreadReadAllowed(source, destination, grants)),
        ),
      changes: SubscriptionRef.changes(state),
      set: (source, destination, allowed) => {
        const sourceConnectionKey = gitHubRoutingConnectionKey(source);
        const destinationConnectionKey = gitHubRoutingConnectionKey(destination);
        if (
          sourceConnectionKey === null ||
          destinationConnectionKey === null ||
          source.target.environmentId === destination.target.environmentId
        )
          return Effect.fail(
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Choose two saved connections to share threads.",
            }),
          );
        return update((grants) => [
          ...grants.filter(
            (grant) =>
              grant.sourceEnvironmentId !== source.target.environmentId ||
              grant.destinationEnvironmentId !== destination.target.environmentId,
          ),
          ...(allowed
            ? [
                {
                  sourceEnvironmentId: source.target.environmentId,
                  sourceConnectionKey,
                  destinationEnvironmentId: destination.target.environmentId,
                  destinationConnectionKey,
                },
              ]
            : []),
        ]);
      },
      forget: (environmentId) =>
        update((grants) =>
          grants.filter(
            (grant) =>
              grant.sourceEnvironmentId !== environmentId &&
              grant.destinationEnvironmentId !== environmentId,
          ),
        ),
    });
  },
);
