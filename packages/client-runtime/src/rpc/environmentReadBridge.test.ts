import { describe, expect, it } from "@effect/vitest";
import {
  ENVIRONMENT_READ_WS_METHODS,
  EnvironmentId,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  EnvironmentReadError,
  EnvironmentReadRegistration,
  type EnvironmentReadRequest,
  type EnvironmentReadResponse,
  type EnvironmentReadResult,
  type EnvironmentReadStreamEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";
import { SocketReadError } from "effect/socket/Socket";
import { TestClock } from "effect/testing";

import {
  AgentThreadReadPermissions,
  makeAgentThreadReadPermissions,
} from "../connection/agentThreadReadPermissions.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { layerRemoteHttpClient } from "./http.ts";
import type { RpcSession } from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { v2Project } from "../state/orchestrationV2TestFixtures.ts";
import { respondToEnvironmentRead, runEnvironmentReadBridge } from "./environmentReadBridge.ts";

const readRequest: EnvironmentReadRequest = { operation: "project.list", limit: 10 };
const result: EnvironmentReadResult = {
  operation: "project.list",
  data: { projects: [], nextCursor: null },
};
const encodeEnvironmentReadRegistration = Schema.encodeEffect(EnvironmentReadRegistration);

const makeHarness = Effect.fn("TestAgentThreadRead.makeHarness")(function* (options?: {
  readonly allowed?: boolean;
  readonly read?: Effect.Effect<EnvironmentReadResult, EnvironmentReadError>;
  readonly subscriptionFailures?: ReadonlyArray<
    RpcClientError.RpcClientError | EnvironmentAuthorizationError
  >;
  readonly subscriptionFailed?: Deferred.Deferred<void>;
  readonly scopes?: ReadonlyArray<string>;
  readonly reportedEnvironmentId?: EnvironmentId;
  readonly additionalEnvironments?: number;
}) {
  const events = yield* Queue.unbounded<EnvironmentReadStreamEvent>();
  const responses = yield* Queue.unbounded<EnvironmentReadResponse>();
  const registrations = yield* Queue.unbounded<EnvironmentReadRegistration>();
  const stopped = yield* Deferred.make<void>();
  const source: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("source"),
      label: "Source",
      httpBaseUrl: "https://source.test",
      wsBaseUrl: "wss://source.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
  const destination: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("destination"),
      label: "Destination",
      httpBaseUrl: "https://destination.test",
      wsBaseUrl: "wss://destination.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
  const reads: Array<{ environmentId: EnvironmentId; input: EnvironmentReadRequest }> = [];
  const httpCalls: string[] = [];
  const subscriptionSources: EnvironmentId[] = [];
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  const additional = Array.from({ length: options?.additionalEnvironments ?? 0 }, (_, index) => ({
    ...source,
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make(`additional-${index}`),
      label: `Additional ${index}`,
      httpBaseUrl: `https://additional-${index}.test`,
      wsBaseUrl: `wss://additional-${index}.test`,
    }),
  }));
  const catalog = [source, destination, ...additional];
  for (const entry of catalog) {
    const id = entry.target.environmentId;
    const session: RpcSession = {
      client: {
        [ENVIRONMENT_READ_WS_METHODS.read]: (input: EnvironmentReadRequest) =>
          Effect.sync(() => {
            reads.push({ environmentId: id, input });
          }).pipe(Effect.andThen(options?.read ?? Effect.succeed(result))),
        [ENVIRONMENT_READ_WS_METHODS.subscribe]: (input: EnvironmentReadRegistration) => {
          const started = Effect.sync(() => {
            subscriptionSources.push(id);
          });
          const failure =
            id === source.target.environmentId
              ? options?.subscriptionFailures?.[
                  subscriptionSources.filter((sourceId) => sourceId === id).length
                ]
              : undefined;
          if (failure !== undefined)
            return Stream.fail(failure).pipe(
              Stream.onStart(started),
              Stream.ensuring(
                options?.subscriptionFailed === undefined
                  ? Effect.void
                  : Deferred.succeed(options.subscriptionFailed, undefined),
              ),
            );
          return (
            id === source.target.environmentId || id === destination.target.environmentId
              ? Stream.fromQueue(events)
              : Stream.never
          ).pipe(
            Stream.onStart(started.pipe(Effect.andThen(Queue.offer(registrations, input)))),
            Stream.ensuring(Deferred.succeed(stopped, undefined)),
          );
        },
        [ENVIRONMENT_READ_WS_METHODS.respond]: (response: EnvironmentReadResponse) =>
          Queue.offer(responses, response).pipe(Effect.asVoid),
      } as unknown as WsRpcProtocolClient,
      initialConfig: Effect.succeed({
        environment: { environmentId: options?.reportedEnvironmentId ?? id },
      } as ServerConfig),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
      subscribeServerConfig: () => Stream.empty,
    };
    supervisors.set(
      id,
      EnvironmentSupervisor.of({
        target: entry.target,
        session: yield* SubscriptionRef.make(Option.some(session)),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId: id,
            target: entry.target,
            label: entry.target.label,
            httpBaseUrl: "https://" + id + ".test",
            socketUrl: "wss://" + id + ".test",
            httpAuthorization: null,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(catalog.map((entry) => [entry.target.environmentId, entry])),
  );
  const registry = EnvironmentRegistry.of({
    entries,
    run: (id, effect) => {
      const supervisor = supervisors.get(id);
      return supervisor === undefined
        ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
        : Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    },
    runStream: (id, stream) => {
      const supervisor = supervisors.get(id);
      return supervisor === undefined
        ? Stream.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
        : Stream.provideService(stream, EnvironmentSupervisor, supervisor);
    },
  } as EnvironmentRegistry["Service"]);
  const permissions = yield* makeAgentThreadReadPermissions({
    read: Effect.succeed([]),
    write: () => Effect.void,
  });
  if (options?.allowed !== false) yield* permissions.set(source, destination, true);
  const sourceSession = Option.getOrThrow(
    yield* SubscriptionRef.get(supervisors.get(source.target.environmentId)!.session),
  );
  const event = {
    type: "request",
    connectionId: "connection",
    requestId: "request",
    environmentId: destination.target.environmentId,
    request: readRequest,
  } as const;
  const layer = Layer.mergeAll(
    Layer.succeed(EnvironmentRegistry, registry),
    Layer.succeed(AgentThreadReadPermissions, permissions),
    layerRemoteHttpClient(async (input) => {
      httpCalls.push(String(input));
      return Response.json({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: options?.scopes ?? ["orchestration:read"],
      });
    }),
  );
  return {
    source,
    destination,
    additional,
    sourceSession,
    event,
    layer,
    reads,
    httpCalls,
    entries,
    supervisors,
    permissions,
    events,
    responses,
    registrations,
    stopped,
    subscriptionSources,
  };
});

describe("agent environment read responder", () => {
  it.effect("reads only the named destination with a current auth check", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "ok", result });
      expect(h.reads).toEqual([
        { environmentId: h.destination.target.environmentId, input: readRequest },
      ]);
      expect(h.httpCalls).toEqual(["https://destination.test/api/auth/session"]);
    }),
  );

  it.effect("rejects ungranted destinations and changed identities before reading", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ allowed: false });
      const respond = (event = h.event) =>
        respondToEnvironmentRead(h.source.target.environmentId, h.sourceSession, event).pipe(
          Effect.provide(h.layer),
        );
      expect(yield* respond()).toEqual({ status: "error", code: "permission-denied" });
      yield* h.permissions.set(h.source, h.destination, true);
      expect(yield* respond({ ...h.event, environmentId: EnvironmentId.make("unknown") })).toEqual({
        status: "error",
        code: "permission-denied",
      });
      yield* SubscriptionRef.update(h.entries, (entries) =>
        new Map(entries).set(h.destination.target.environmentId, {
          ...h.destination,
          target: new PrimaryConnectionTarget({
            environmentId: h.destination.target.environmentId,
            label: "Replacement",
            httpBaseUrl: "https://changed.test",
            wsBaseUrl: "wss://changed.test",
          }),
        }),
      );
      expect(yield* respond()).toEqual({ status: "error", code: "permission-denied" });
      expect(h.reads).toEqual([]);
      expect(h.httpCalls).toEqual([]);
    }),
  );

  it.effect("returns explicit errors for offline and unsupported destinations", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* SubscriptionRef.set(
        h.supervisors.get(h.destination.target.environmentId)!.session,
        Option.none(),
      );
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code: "offline" });
      yield* SubscriptionRef.update(h.entries, (entries) =>
        new Map(entries).set(h.destination.target.environmentId, {
          ...h.destination,
          unsupportedReason: "unsupported",
        }),
      );
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code: "unsupported" });
      expect(h.reads).toEqual([]);
    }),
  );

  it.effect("rejects missing destination auth scopes before dispatch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ scopes: [] });
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code: "permission-denied" });
      expect(h.reads).toEqual([]);
    }),
  );

  it.effect("rejects a connection that reports the wrong environment", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        reportedEnvironmentId: EnvironmentId.make("wrong-environment"),
      });
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code: "invalid-response" });
      expect(h.reads).toEqual([]);
    }),
  );

  it.effect.each([
    {
      name: "wrong operation",
      value: { operation: "thread.search", data: { matches: [] } } satisfies EnvironmentReadResult,
      code: "invalid-response",
    },
    {
      name: "too large",
      value: {
        operation: "project.list",
        data: {
          projects: [{ ...v2Project, deletedAt: null, title: "x".repeat(512 * 1024) }],
          nextCursor: null,
        },
      } satisfies EnvironmentReadResult,
      code: "too-large",
    },
  ])("rejects a $name result", ({ value, code }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ read: Effect.succeed(value) });
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code });
    }),
  );

  it.effect("preserves a destination failure", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        read: Effect.fail(new EnvironmentReadError({ code: "not-found" })),
      });
      expect(
        yield* respondToEnvironmentRead(
          h.source.target.environmentId,
          h.sourceSession,
          h.event,
        ).pipe(Effect.provide(h.layer)),
      ).toEqual({ status: "error", code: "not-found" });
    }),
  );

  it.effect("does not release a result after grant revocation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        read: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(result),
        ),
      });
      const fiber = yield* respondToEnvironmentRead(
        h.source.target.environmentId,
        h.sourceSession,
        h.event,
      ).pipe(Effect.provide(h.layer), Effect.forkChild);
      yield* Deferred.await(started);
      yield* h.permissions.set(h.source, h.destination, false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "error", code: "permission-denied" });
    }),
  );

  it.effect("does not release a result after destination disconnect", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        read: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(result),
        ),
      });
      const fiber = yield* respondToEnvironmentRead(
        h.source.target.environmentId,
        h.sourceSession,
        h.event,
      ).pipe(Effect.provide(h.layer), Effect.forkChild);
      yield* Deferred.await(started);
      yield* SubscriptionRef.set(
        h.supervisors.get(h.destination.target.environmentId)!.session,
        Option.none(),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "error", code: "offline" });
    }),
  );
});

describe("agent environment bridge lifetime", () => {
  it.effect.each([
    { label: `${"x".repeat(199)} moretext`, expected: "x".repeat(199) },
    { label: "   ", expected: "Environment" },
  ])("advertises a trimmed, encodable name for saved label '$label'", ({ label, expected }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* SubscriptionRef.update(h.entries, (entries) =>
        new Map(entries).set(h.destination.target.environmentId, {
          ...h.destination,
          target: new PrimaryConnectionTarget({
            environmentId: h.destination.target.environmentId,
            label,
            httpBaseUrl: "https://destination.test",
            wsBaseUrl: "wss://destination.test",
          }),
        }),
      );
      const fiber = yield* runEnvironmentReadBridge().pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      const registration = yield* Queue.take(h.registrations);
      expect(registration.environments[0]?.name).toBe(expected);
      const encoded = yield* encodeEnvironmentReadRegistration(registration);
      expect(encoded.environments).toEqual([
        {
          environmentId: h.destination.target.environmentId,
          name: expected,
          status: "online",
        },
      ]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect.each(["unshared retry", "independent retry", "independent grant"] as const)(
    "keeps an in-flight read alive during an %s change",
    (action) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const observed = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          additionalEnvironments: action === "unshared retry" ? 1 : 3,
          read: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(result),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          ),
        });
        if (action !== "unshared retry")
          yield* h.permissions.set(h.additional[1]!, h.additional[2]!, true);
        let changed = false;
        const lastId = h.additional.at(-1)!.target.environmentId;
        const fiber = yield* runEnvironmentReadBridge().pipe(
          Effect.provideService(AgentThreadReadPermissions, {
            ...h.permissions,
            get: (source, destination) =>
              h.permissions
                .get(source, destination)
                .pipe(
                  Effect.tap(() =>
                    source.target.environmentId === lastId &&
                    destination.target.environmentId === lastId
                      ? Deferred.succeed(changed ? observed : ready, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provide(h.layer),
          Effect.forkChild,
        );
        yield* Queue.take(h.registrations);
        yield* Deferred.await(ready);
        yield* Queue.offer(h.events, { type: "connected", connectionId: "connection" });
        yield* Queue.offer(h.events, h.event);
        yield* Deferred.await(started);
        changed = true;
        if (action === "independent grant")
          yield* h.permissions.set(h.additional[1]!, h.additional[2]!, false);
        else {
          const supervisor = h.supervisors.get(lastId)!;
          yield* SubscriptionRef.update(supervisor.state, (state) => ({
            ...state,
            phase: "backoff" as const,
          }));
        }
        yield* Deferred.await(observed);
        yield* Deferred.succeed(release, undefined);
        const response = yield* Effect.raceFirst(
          Queue.take(h.responses).pipe(Effect.map((response) => response.response)),
          Deferred.await(cancelled).pipe(Effect.as("cancelled")),
        );
        expect(response).toEqual({ status: "ok", result });
        expect(
          h.subscriptionSources.filter((id) => id === h.source.target.environmentId),
        ).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect("allows a read to use its full deadline before sending the response", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        read: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(result),
          Effect.ensuring(Deferred.succeed(finished, undefined)),
        ),
      });
      const fiber = yield* runEnvironmentReadBridge().pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      yield* Queue.take(h.registrations);
      yield* Queue.offer(h.events, { type: "connected", connectionId: "connection" });
      yield* Queue.offer(h.events, h.event);
      yield* Deferred.await(started);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Deferred.isDone(finished)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Queue.take(h.responses)).response).toEqual({ status: "ok", result });
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("advertises only granted destinations and stops on revocation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const fiber = yield* runEnvironmentReadBridge().pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      const registration = yield* Queue.take(h.registrations);
      expect(registration.environments).toEqual([
        {
          environmentId: h.destination.target.environmentId,
          name: "Destination",
          status: "online",
        },
      ]);
      yield* Queue.offer(h.events, { type: "connected", connectionId: "connection" });
      yield* Queue.offer(h.events, { ...h.event, connectionId: "old-connection" });
      yield* Queue.offer(h.events, h.event);
      expect((yield* Queue.take(h.responses)).response).toEqual({ status: "ok", result });
      expect(h.reads).toHaveLength(1);
      yield* h.permissions.set(h.source, h.destination, false);
      yield* Deferred.await(h.stopped);
      yield* Fiber.interrupt(fiber);
      expect(h.subscriptionSources).toEqual([h.source.target.environmentId]);
    }),
  );

  it.effect.each(["unmount", "revoke", "replace"] as const)(
    "cancels an in-flight destination read on %s",
    (action) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          read: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
        });
        const fiber = yield* runEnvironmentReadBridge().pipe(
          Effect.provide(h.layer),
          Effect.forkChild,
        );
        yield* Queue.take(h.registrations);
        yield* Queue.offer(h.events, { type: "connected", connectionId: "connection" });
        yield* Queue.offer(h.events, h.event);
        yield* Deferred.await(started);
        if (action === "revoke") yield* h.permissions.set(h.source, h.destination, false);
        else if (action === "replace") {
          const supervisor = h.supervisors.get(h.destination.target.environmentId)!;
          const current = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
          yield* SubscriptionRef.set(supervisor.session, Option.some({ ...current }));
        } else yield* Fiber.interrupt(fiber);
        yield* Deferred.await(cancelled);
        yield* Fiber.interrupt(fiber);
        expect(yield* Queue.size(h.responses)).toBe(0);
      }),
  );

  it.effect(
    "recovers transient subscription failures on the same session with capped backoff",
    () =>
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const error = new RpcClientError.RpcClientError({
          reason: new SocketReadError({ cause: "temporary read failure" }),
        });
        const delays = [1, 2, 4, 8, 16, 30, 30];
        const h = yield* makeHarness({
          subscriptionFailures: delays.map(() => error),
          subscriptionFailed: failed,
        });
        const fiber = yield* runEnvironmentReadBridge().pipe(
          Effect.provide(h.layer),
          Effect.forkChild,
        );
        yield* Deferred.await(failed);
        for (const [index, seconds] of delays.entries()) {
          yield* TestClock.adjust(seconds * 1000 - 1);
          expect(h.subscriptionSources).toHaveLength(index + 1);
          yield* TestClock.adjust(1);
          expect(h.subscriptionSources).toHaveLength(index + 2);
        }
        yield* Queue.take(h.registrations);
        expect(
          Option.getOrThrow(
            yield* SubscriptionRef.get(h.supervisors.get(h.source.target.environmentId)!.session),
          ),
        ).toBe(h.sourceSession);
        yield* Queue.offer(h.events, { type: "connected", connectionId: "recovered" });
        yield* Queue.offer(h.events, { ...h.event, connectionId: "connection" });
        yield* Queue.offer(h.events, { ...h.event, connectionId: "recovered" });
        expect((yield* Queue.take(h.responses)).response).toEqual({ status: "ok", result });
        expect(h.reads).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect.each([
    {
      name: "unsupported",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "Unknown method",
          cause: "unsupported",
        }),
      }),
    },
    {
      name: "unauthorized",
      error: new EnvironmentAuthorizationError({
        ...authScopeRequiredResponse("orchestration:read"),
        message: "Read access required",
      }),
    },
  ])("does not retry an $name broker until reconnect", ({ error }) =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const h = yield* makeHarness({ subscriptionFailures: [error], subscriptionFailed: failed });
      const fiber = yield* runEnvironmentReadBridge().pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(failed);
      yield* TestClock.adjust("2 minutes");
      expect(h.subscriptionSources).toHaveLength(1);
      yield* h.permissions.set(h.source, h.destination, false);
      yield* h.permissions.set(h.source, h.destination, true);
      yield* h.permissions.set(h.destination, h.source, true);
      expect((yield* Queue.take(h.registrations)).environments).toEqual([
        { environmentId: h.source.target.environmentId, name: "Source", status: "online" },
      ]);
      expect(
        h.subscriptionSources.filter((id) => id === h.source.target.environmentId),
      ).toHaveLength(1);
      yield* SubscriptionRef.set(
        h.supervisors.get(h.source.target.environmentId)!.session,
        Option.some({ ...h.sourceSession }),
      );
      expect((yield* Queue.take(h.registrations)).environments).toEqual([
        {
          environmentId: h.destination.target.environmentId,
          name: "Destination",
          status: "online",
        },
      ]);
      expect(
        h.subscriptionSources.filter((id) => id === h.source.target.environmentId),
      ).toHaveLength(2);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
