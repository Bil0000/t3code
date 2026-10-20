import {
  AgentThreadReadPermissions,
  StoredAgentThreadReadGrant,
  agentThreadReadAllowed,
  gitHubRoutingConnectionKey,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const PREFIX = "t3code:agent-thread-read:";
const CHANGED = "t3code:agent-thread-read-changed";
const isGrant = Schema.is(StoredAgentThreadReadGrant);
const grantKey = (source: string, destination: string) =>
  `${PREFIX}${JSON.stringify([source, destination])}`;

export function makeBrowserAgentThreadReadPermissions(
  browser: Pick<Window, "localStorage"> & EventTarget = window,
) {
  const readAll = (): ReadonlyArray<StoredAgentThreadReadGrant> => {
    try {
      const grants: StoredAgentThreadReadGrant[] = [];
      for (let index = 0; index < browser.localStorage.length; index++) {
        const key = browser.localStorage.key(index);
        if (!key?.startsWith(PREFIX)) continue;
        const raw = browser.localStorage.getItem(key);
        const value: unknown = raw === null ? null : JSON.parse(raw);
        if (
          isGrant(value) &&
          key === grantKey(value.sourceEnvironmentId, value.destinationEnvironmentId)
        )
          grants.push(value);
      }
      return grants;
    } catch {
      return [];
    }
  };
  const write = (operation: () => void) =>
    Effect.try({
      try: () => {
        operation();
        browser.dispatchEvent(new Event(CHANGED));
      },
      catch: () =>
        new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not save agent thread sharing permissions.",
        }),
    });
  return AgentThreadReadPermissions.of({
    get: (source, destination) =>
      Effect.sync(() => agentThreadReadAllowed(source, destination, readAll())),
    changes: Stream.callback<ReadonlyArray<StoredAgentThreadReadGrant>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (event: Event) => {
            if (
              event.type === "storage" &&
              (event as StorageEvent).key !== null &&
              !(event as StorageEvent).key?.startsWith(PREFIX)
            )
              return;
            Queue.offerUnsafe(queue, readAll());
          };
          browser.addEventListener("storage", listener);
          browser.addEventListener(CHANGED, listener);
          Queue.offerUnsafe(queue, readAll());
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            browser.removeEventListener("storage", listener);
            browser.removeEventListener(CHANGED, listener);
          }),
      ).pipe(Effect.asVoid),
    ),
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
      return write(() => {
        const key = grantKey(source.target.environmentId, destination.target.environmentId);
        if (!allowed) browser.localStorage.removeItem(key);
        else
          browser.localStorage.setItem(
            key,
            JSON.stringify({
              sourceEnvironmentId: source.target.environmentId,
              sourceConnectionKey,
              destinationEnvironmentId: destination.target.environmentId,
              destinationConnectionKey,
            }),
          );
      });
    },
    forget: (environmentId) =>
      write(() => {
        for (const grant of readAll()) {
          if (
            grant.sourceEnvironmentId === environmentId ||
            grant.destinationEnvironmentId === environmentId
          )
            browser.localStorage.removeItem(
              grantKey(grant.sourceEnvironmentId, grant.destinationEnvironmentId),
            );
        }
      }),
  });
}
