import {
  EnvironmentReadError,
  EnvironmentReadResult,
  type EnvironmentId,
  type EnvironmentReadRegistration,
  type EnvironmentReadRequest,
  type EnvironmentReadResponse,
  type EnvironmentReadStreamEvent,
  type EnvironmentReadTarget,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

interface Owner {
  readonly sessionId: string;
  readonly socketId: string;
}
interface Connection {
  readonly owner: Owner;
  readonly registration: EnvironmentReadRegistration;
  readonly connectionId: string;
  readonly queue: Queue.Queue<EnvironmentReadStreamEvent, Cause.Done>;
}
interface Pending {
  readonly connection: Connection;
  readonly environmentId: EnvironmentId;
  readonly request: EnvironmentReadRequest;
  readonly deferred: Deferred.Deferred<EnvironmentReadResult, EnvironmentReadError>;
}

export class EnvironmentReadBroker extends Context.Service<
  EnvironmentReadBroker,
  {
    readonly connect: (
      owner: Owner,
      registration: EnvironmentReadRegistration,
    ) => Stream.Stream<EnvironmentReadStreamEvent>;
    readonly respond: (
      owner: Owner,
      response: EnvironmentReadResponse,
    ) => Effect.Effect<void, EnvironmentReadError>;
    readonly list: (
      sessionId?: string,
    ) => Effect.Effect<ReadonlyArray<EnvironmentReadTarget>, EnvironmentReadError>;
    readonly invoke: (
      sessionId: string | undefined,
      environmentId: EnvironmentId,
      request: EnvironmentReadRequest,
    ) => Effect.Effect<EnvironmentReadResult, EnvironmentReadError>;
  }
>()("t3/mcp/EnvironmentReadBroker") {}

const key = (owner: Owner, clientId: string) => `${owner.sessionId}\u0000${clientId}`;
const sameOwner = (left: Owner, right: Owner) =>
  left.sessionId === right.sessionId && left.socketId === right.socketId;
const isReadResult = Schema.is(EnvironmentReadResult);
const encodeReadResult = Schema.encodeEffect(Schema.fromJsonString(EnvironmentReadResult));

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const connections = new Map<string, Connection>();
  const pending = new Map<string, Pending>();

  const disconnect = Effect.fn("EnvironmentReadBroker.disconnect")(function* (
    connection: Connection,
  ) {
    const id = key(connection.owner, connection.registration.clientId);
    if (connections.get(id) === connection) connections.delete(id);
    for (const [requestId, entry] of pending) {
      if (entry.connection !== connection) continue;
      pending.delete(requestId);
      yield* Deferred.fail(
        entry.deferred,
        new EnvironmentReadError({ code: "offline", environmentId: entry.environmentId }),
      );
    }
    yield* Queue.shutdown(connection.queue);
  });

  const acquire = Effect.fn("EnvironmentReadBroker.acquire")(function* (
    owner: Owner,
    registration: EnvironmentReadRegistration,
  ) {
    const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const queue = yield* Queue.dropping<EnvironmentReadStreamEvent, Cause.Done>(32);
    const connection = { owner, registration, connectionId, queue };
    const previous = connections.get(key(owner, registration.clientId));
    connections.set(key(owner, registration.clientId), connection);
    if (previous !== undefined) yield* disconnect(previous);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    return connection;
  });

  const selectConnections = Effect.fn("EnvironmentReadBroker.selectConnections")(function* (
    sessionId: string | undefined,
    environmentId?: EnvironmentId,
  ) {
    const eligible = [...connections.values()].filter(
      (connection) =>
        connection.registration.environments.length > 0 &&
        (sessionId === undefined || connection.owner.sessionId === sessionId) &&
        (environmentId === undefined ||
          connection.registration.environments.some(
            (target) => target.environmentId === environmentId,
          )),
    );
    if (new Set(eligible.map((connection) => connection.owner.sessionId)).size > 1) {
      return yield* new EnvironmentReadError({
        code: "permission-denied",
        ...(environmentId === undefined ? {} : { environmentId }),
      });
    }
    return eligible;
  });

  const list = Effect.fn("EnvironmentReadBroker.list")(function* (sessionId?: string) {
    const selected = yield* selectConnections(sessionId);
    return [
      ...new Map(
        selected.flatMap((connection) =>
          connection.registration.environments.map(
            (target) => [target.environmentId, target] as const,
          ),
        ),
      ).values(),
    ].slice(0, 100);
  });

  const respond = Effect.fn("EnvironmentReadBroker.respond")(function* (
    owner: Owner,
    response: EnvironmentReadResponse,
  ) {
    const entry = pending.get(response.requestId);
    if (
      entry === undefined ||
      !sameOwner(entry.connection.owner, owner) ||
      entry.connection.connectionId !== response.connectionId ||
      entry.connection.registration.clientId !== response.clientId ||
      connections.get(key(owner, response.clientId)) !== entry.connection
    ) {
      return yield* new EnvironmentReadError({ code: "permission-denied" });
    }
    if (response.response.status === "error") {
      yield* Deferred.fail(
        entry.deferred,
        new EnvironmentReadError({
          code: response.response.code,
          environmentId: entry.environmentId,
        }),
      );
      return;
    }
    const result = response.response.result;
    if (result.operation !== entry.request.operation || !isReadResult(result)) {
      yield* Deferred.fail(
        entry.deferred,
        new EnvironmentReadError({ code: "invalid-response", environmentId: entry.environmentId }),
      );
      return;
    }
    const encoded = yield* encodeReadResult(result).pipe(Effect.orElseSucceed(() => null));
    if (encoded === null) {
      yield* Deferred.fail(
        entry.deferred,
        new EnvironmentReadError({ code: "invalid-response", environmentId: entry.environmentId }),
      );
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) {
      yield* Deferred.fail(
        entry.deferred,
        new EnvironmentReadError({ code: "too-large", environmentId: entry.environmentId }),
      );
      return;
    }
    yield* Deferred.succeed(entry.deferred, result);
  });

  const invoke = Effect.fn("EnvironmentReadBroker.invoke")(function* (
    sessionId: string | undefined,
    environmentId: EnvironmentId,
    request: EnvironmentReadRequest,
  ) {
    const selected = yield* selectConnections(sessionId, environmentId);
    const connection = selected.at(-1);
    const target = connection?.registration.environments.find(
      (entry) => entry.environmentId === environmentId,
    );
    if (connection === undefined || target === undefined)
      return yield* new EnvironmentReadError({ code: "offline", environmentId });
    if (target.status !== "online")
      return yield* new EnvironmentReadError({ code: target.status, environmentId });
    if (pending.size >= 32)
      return yield* new EnvironmentReadError({ code: "offline", environmentId });
    const deferred = yield* Deferred.make<EnvironmentReadResult, EnvironmentReadError>();
    const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const entry = { connection, environmentId, request, deferred };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        pending.set(requestId, entry);
      }),
      () =>
        Effect.gen(function* () {
          if (
            connections.get(key(connection.owner, connection.registration.clientId)) !== connection
          )
            return yield* new EnvironmentReadError({ code: "offline", environmentId });
          const accepted = yield* Queue.offer(connection.queue, {
            type: "request",
            connectionId: connection.connectionId,
            requestId,
            environmentId,
            request,
          });
          if (!accepted) return yield* new EnvironmentReadError({ code: "offline", environmentId });
          return yield* Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.fail(new EnvironmentReadError({ code: "timeout", environmentId })),
            }),
          );
        }),
      () =>
        Effect.sync(() => {
          pending.delete(requestId);
        }),
    );
  });

  return EnvironmentReadBroker.of({
    connect: (owner, registration) =>
      Stream.unwrap(
        Effect.acquireRelease(acquire(owner, registration), disconnect).pipe(
          Effect.map((connection) => Stream.fromQueue(connection.queue)),
        ),
      ),
    respond,
    list,
    invoke,
  });
});

export const layer = Layer.effect(EnvironmentReadBroker, make);
