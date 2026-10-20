import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type EnvironmentReadResult,
  type EnvironmentReadStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Broker from "./EnvironmentReadBroker.ts";

const owner = { sessionId: "session-a", socketId: "socket-a" };
const environmentId = EnvironmentId.make("remote");
const registration = {
  clientId: "client",
  environments: [{ environmentId, name: "Remote", status: "online" as const }],
};
const request = { operation: "project.list" as const };
const result = { operation: "project.list" as const, data: { projects: [], nextCursor: null } };
type RequestEvent = Extract<EnvironmentReadStreamEvent, { type: "request" }>;

it.layer(Broker.layer.pipe(Layer.provide(NodeServices.layer)), { timeout: "10 seconds" })(
  "EnvironmentReadBroker",
  (it) => {
    it.effect("routes reads and rejects a response from another session or socket", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        const ready = yield* Deferred.make<void>();
        const received = yield* Deferred.make<RequestEvent>();
        yield* broker.connect(owner, registration).pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(ready, undefined)
              : Deferred.succeed(received, event),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const read = yield* broker
          .invoke(owner.sessionId, environmentId, request)
          .pipe(Effect.forkScoped);
        const event = yield* Deferred.await(received);
        const response = {
          clientId: registration.clientId,
          connectionId: event.connectionId,
          requestId: event.requestId,
          response: { status: "ok" as const, result },
        };
        expect(
          (yield* broker.respond({ ...owner, sessionId: "other" }, response).pipe(Effect.flip))
            .code,
        ).toBe("permission-denied");
        expect(
          (yield* broker.respond({ ...owner, socketId: "other" }, response).pipe(Effect.flip)).code,
        ).toBe("permission-denied");
        yield* broker.respond(owner, response);
        expect(yield* Fiber.join(read)).toEqual(result);
      }),
    );

    it.effect(
      "replacement fails pending reads and old finalizers do not remove the new connection",
      () =>
        Effect.gen(function* () {
          const broker = yield* Broker.EnvironmentReadBroker;
          const ready = yield* Deferred.make<void>();
          const received = yield* Deferred.make<RequestEvent>();
          const old = yield* broker.connect(owner, registration).pipe(
            Stream.runForEach((event) =>
              event.type === "connected"
                ? Deferred.succeed(ready, undefined)
                : Deferred.succeed(received, event),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          const read = yield* broker
            .invoke(owner.sessionId, environmentId, request)
            .pipe(Effect.flip, Effect.forkScoped);
          const event = yield* Deferred.await(received);
          const nextReady = yield* Deferred.make<void>();
          const nextReceived = yield* Deferred.make<RequestEvent>();
          const nextOwner = { ...owner, socketId: "new-socket" };
          const next = yield* broker.connect(nextOwner, registration).pipe(
            Stream.runForEach((event) =>
              event.type === "connected"
                ? Deferred.succeed(nextReady, undefined)
                : Deferred.succeed(nextReceived, event),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(nextReady);
          expect((yield* Fiber.join(read)).code).toBe("offline");
          yield* Fiber.interrupt(old);
          expect(yield* broker.list(owner.sessionId)).toEqual(registration.environments);
          expect(
            (yield* broker
              .respond(owner, {
                clientId: registration.clientId,
                connectionId: event.connectionId,
                requestId: event.requestId,
                response: { status: "ok", result },
              })
              .pipe(Effect.flip)).code,
          ).toBe("permission-denied");
          const nextRead = yield* broker
            .invoke(owner.sessionId, environmentId, request)
            .pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(nextReceived);
          yield* Fiber.interrupt(next);
          expect((yield* Fiber.join(nextRead)).code).toBe("offline");
          expect(yield* broker.list(owner.sessionId)).toEqual([]);
          expect(
            (yield* broker.invoke(owner.sessionId, environmentId, request).pipe(Effect.flip)).code,
          ).toBe("offline");
        }),
    );

    it.effect("lists the online target regardless of client registration order", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        for (const status of ["offline", "unsupported", "permission-denied"] as const) {
          for (const onlineFirst of [true, false]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const unavailable = {
                  clientId: "unavailable",
                  environments: [{ ...registration.environments[0]!, name: "Unavailable", status }],
                };
                for (const client of onlineFirst
                  ? [registration, unavailable]
                  : [unavailable, registration]) {
                  const ready = yield* Deferred.make<void>();
                  yield* broker.connect(owner, client).pipe(
                    Stream.runForEach(() => Deferred.succeed(ready, undefined)),
                    Effect.forkScoped,
                  );
                  yield* Deferred.await(ready);
                }
                expect(yield* broker.list(owner.sessionId)).toEqual(registration.environments);
                expect(yield* broker.list()).toEqual(registration.environments);
              }),
            );
          }
        }
      }),
    );

    it.effect("routes reads through an online client regardless of registration order", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        for (const status of ["offline", "unsupported", "permission-denied"] as const) {
          for (const onlineFirst of [true, false]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const unavailable = {
                  clientId: "unavailable",
                  environments: [{ ...registration.environments[0]!, status }],
                };
                for (const client of onlineFirst
                  ? [registration, unavailable]
                  : [unavailable, registration]) {
                  const ready = yield* Deferred.make<void>();
                  yield* broker.connect(owner, client).pipe(
                    Stream.runForEach((event) =>
                      event.type === "connected"
                        ? Deferred.succeed(ready, undefined)
                        : broker.respond(owner, {
                            clientId: client.clientId,
                            connectionId: event.connectionId,
                            requestId: event.requestId,
                            response: { status: "ok", result },
                          }),
                    ),
                    Effect.forkScoped,
                  );
                  yield* Deferred.await(ready);
                }
                expect(yield* broker.invoke(owner.sessionId, environmentId, request)).toEqual(
                  result,
                );
                expect(yield* broker.invoke(undefined, environmentId, request)).toEqual(result);
              }),
            );
          }
        }
      }),
    );

    it.effect("does not mix registries from different authenticated clients", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        const readyA = yield* Deferred.make<void>();
        const readyB = yield* Deferred.make<void>();
        yield* broker.connect(owner, registration).pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(readyA, undefined)
              : broker.respond(owner, {
                  clientId: registration.clientId,
                  connectionId: event.connectionId,
                  requestId: event.requestId,
                  response: { status: "ok", result },
                }),
          ),
          Effect.forkScoped,
        );
        yield* broker
          .connect(
            { sessionId: "session-b", socketId: "b" },
            {
              ...registration,
              environments: [
                { ...registration.environments[0]!, name: "Other", status: "offline" },
              ],
            },
          )
          .pipe(
            Stream.runForEach(() => Deferred.succeed(readyB, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(readyA);
        yield* Deferred.await(readyB);
        expect(yield* broker.list(owner.sessionId)).toEqual(registration.environments);
        expect(yield* broker.list("session-b")).toEqual([
          { ...registration.environments[0]!, name: "Other", status: "offline" },
        ]);
        expect(yield* broker.list("unrelated")).toEqual([]);
        expect(yield* broker.invoke(owner.sessionId, environmentId, request)).toEqual(result);
        expect(
          (yield* broker.invoke("session-b", environmentId, request).pipe(Effect.flip)).code,
        ).toBe("offline");
        expect(
          (yield* broker.invoke("unrelated", environmentId, request).pipe(Effect.flip)).code,
        ).toBe("offline");
        expect((yield* broker.list().pipe(Effect.flip)).code).toBe("permission-denied");
        expect(
          (yield* broker.invoke(undefined, environmentId, request).pipe(Effect.flip)).code,
        ).toBe("permission-denied");
      }),
    );

    it.effect("reports unavailable targets and times out without retaining a request", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        for (const status of ["offline", "permission-denied", "unsupported"] as const) {
          const ready = yield* Deferred.make<void>();
          const stream = yield* broker
            .connect(owner, {
              ...registration,
              environments: [{ ...registration.environments[0]!, status }],
            })
            .pipe(
              Stream.runForEach(() => Deferred.succeed(ready, undefined)),
              Effect.forkScoped,
            );
          yield* Deferred.await(ready);
          expect(
            (yield* broker.invoke(owner.sessionId, environmentId, request).pipe(Effect.flip)).code,
          ).toBe(status);
          yield* Fiber.interrupt(stream);
        }
        const received = yield* Deferred.make<RequestEvent>();
        const ready = yield* Deferred.make<void>();
        yield* broker.connect(owner, registration).pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(ready, undefined)
              : Deferred.succeed(received, event),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const read = yield* broker
          .invoke(owner.sessionId, environmentId, request)
          .pipe(Effect.flip, Effect.forkScoped);
        const event = yield* Deferred.await(received);
        yield* TestClock.adjust("16 seconds");
        expect((yield* Fiber.join(read)).code).toBe("timeout");
        expect(
          (yield* broker
            .respond(owner, {
              clientId: registration.clientId,
              connectionId: event.connectionId,
              requestId: event.requestId,
              response: { status: "ok", result },
            })
            .pipe(Effect.flip)).code,
        ).toBe("permission-denied");
      }),
    );
    it.effect("rejects mismatched and oversized replies", () =>
      Effect.gen(function* () {
        const broker = yield* Broker.EnvironmentReadBroker;
        const scenarios: ReadonlyArray<{
          readonly expected: string;
          readonly result: EnvironmentReadResult;
        }> = [
          {
            expected: "invalid-response",
            result: { operation: "thread.search", data: { matches: [] } },
          },
          {
            expected: "too-large",
            result: {
              operation: "project.list",
              data: {
                nextCursor: null,
                projects: [
                  {
                    id: ProjectId.make("project"),
                    title: "x".repeat(512 * 1024),
                    workspaceRoot: "/work/project",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-10-20T00:00:00.000Z",
                    updatedAt: "2026-10-20T00:00:00.000Z",
                    deletedAt: null,
                  },
                ],
              },
            },
          },
        ];
        for (const scenario of scenarios) {
          const ready = yield* Deferred.make<void>();
          const received = yield* Deferred.make<RequestEvent>();
          const stream = yield* broker.connect(owner, registration).pipe(
            Stream.runForEach((event) =>
              event.type === "connected"
                ? Deferred.succeed(ready, undefined)
                : Deferred.succeed(received, event),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          const read = yield* broker
            .invoke(owner.sessionId, environmentId, request)
            .pipe(Effect.flip, Effect.forkScoped);
          const event = yield* Deferred.await(received);
          yield* broker.respond(owner, {
            clientId: registration.clientId,
            requestId: event.requestId,
            connectionId: event.connectionId,
            response: { status: "ok", result: scenario.result },
          });
          expect((yield* Fiber.join(read)).code).toBe(scenario.expected);
          yield* Fiber.interrupt(stream);
        }
      }),
    );
  },
);
