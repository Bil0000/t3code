import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, test } from "vite-plus/test";

import { issueRemoteWebSocketTicket } from "./authorization/remote.ts";
import { PrimaryConnectionTarget } from "./connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "./environment/descriptor.ts";
import type { RemoteEnvironmentRequestError } from "./rpc/http.ts";
import { fetchEnvironmentThreadSnapshot } from "./state/threadSnapshotHttp.ts";
import { applyOrchestrationV2ProjectionEvent } from "./state/orchestrationV2Projection.ts";
import { v2Projection, v2Now } from "./state/orchestrationV2TestFixtures.ts";
import * as RemoteAuthorization from "./authorization/service.ts";
import { RemoteDpopAccessTokenStore } from "./authorization/tokenStore.ts";
import { ConnectionCredentialStore } from "./connection/credentialStore.ts";
import { ConnectionProfileStore } from "./connection/profileStore.ts";
import * as EnvironmentRegistry from "./connection/registry.ts";
import * as ConnectionResolver from "./connection/resolver.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import * as Capabilities from "./platform/capabilities.ts";
import { ManagedRelayClient, ManagedRelayDpopSigner } from "./relay/managedRelay.ts";
import type { RpcSession } from "./rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./state/threadCommands.ts";
import { ThreadHistoryController } from "./state/threadHistoryController.ts";

const timestamp = "2026-09-01T00:00:00.000Z";
const runOptions = { warmupTime: 1_000, time: 1_500 };
const thread: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId: null,
    role: "assistant",
    text: "Message text. ".repeat(40),
    attachments: [],
    streaming: false,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: v2Now,
    updatedAt: v2Now,
  })),
};
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("remote-1"),
  label: "Remote",
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test/ws",
});
const responses = {
  "/.well-known/t3/environment": {
    environmentId: target.environmentId,
    label: target.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { repositoryIdentity: true },
  },
  "/api/auth/websocket-ticket": { ticket: "test-ticket", expiresAt: timestamp },
  "/api/auth/websocket-ticket/rpc": { ticket: "test-ticket", expiresAt: timestamp },
  "/api/orchestration/threads/thread-v2": { snapshotSequence: 1, projection: thread },
};
const httpClient = HttpClient.make((request) =>
  Effect.sync(() => {
    const path = new URL(request.url).pathname as keyof typeof responses;
    return HttpClientResponse.fromWeb(request, Response.json(responses[path]));
  }),
);
const requests: Record<
  string,
  Effect.Effect<unknown, RemoteEnvironmentRequestError, HttpClient.HttpClient>
> = {
  "read remote connection descriptor": fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }),
  "issue remote WebSocket ticket": issueRemoteWebSocketTicket({
    httpBaseUrl: target.httpBaseUrl,
    bearerToken: "test-token",
  }),
  "load remote snapshot with 100 messages": fetchEnvironmentThreadSnapshot({
    prepared: {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    },
    threadId: thread.thread.id,
    signer: Option.none(),
  }),
};

describe("remote HTTP processing with an in-memory transport", () => {
  for (const [name, request] of Object.entries(requests)) {
    test(name, async ({ bench }) => {
      await bench(name, async () => {
        await Effect.runPromise(
          request.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        );
      }).run(runOptions);
    });
  }
});

const controlledRunOptions = { warmup: false, time: 0, iterations: 3 };
const unused = () => Effect.die("Unexpected benchmark dependency");
const presentation = Layer.succeed(Capabilities.ClientPresentation, {
  metadata: { label: "Benchmark", deviceType: "mobile", os: "test" },
});

const prepareSample = (delayMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths: string[] = [];
      let observedHttpWaitSeconds = 0;
      const transport = HttpClient.make((request) =>
        Effect.gen(function* () {
          const path = new URL(request.url).pathname as keyof typeof responses;
          paths.push(path);
          if (delayMs > 0) {
            const started = performance.now();
            yield* Effect.sleep(delayMs);
            observedHttpWaitSeconds += (performance.now() - started) / 1_000;
          }
          return HttpClientResponse.fromWeb(request, Response.json(responses[path]));
        }),
      );
      const dependencies = Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, transport),
        presentation,
        Layer.succeed(ManagedRelayDpopSigner, { thumbprint: unused(), createProof: unused }),
        Layer.succeed(ManagedRelayClient, {
          relayUrl: "https://relay.example.test",
          listEnvironments: unused,
          listDevices: unused,
          createEnvironmentLinkChallenge: unused,
          linkEnvironment: unused,
          unlinkEnvironment: unused,
          getEnvironmentStatus: unused,
          connectEnvironment: unused,
          registerDevice: unused,
          unregisterDevice: unused,
          registerLiveActivity: unused,
          getAgentActivitySnapshot: unused,
          resetTokenCache: Effect.void,
        }),
        Layer.succeed(Capabilities.CloudSession, { identity: unused(), clerkToken: unused() }),
        Layer.succeed(Capabilities.RelayDeviceIdentity, { deviceId: unused() }),
        Layer.succeed(RemoteDpopAccessTokenStore, { get: unused, put: unused, remove: unused }),
        Layer.succeed(Capabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedSome("test-token"),
        }),
        Layer.succeed(Capabilities.SshEnvironmentGateway, {
          provision: unused,
          prepare: unused,
          disconnect: unused,
        }),
        Layer.succeed(ConnectionProfileStore, { get: unused, put: unused, remove: unused }),
        Layer.succeed(ConnectionCredentialStore, { get: unused, put: unused, remove: unused }),
      );
      const layer = ConnectionResolver.layer.pipe(
        Layer.provide(RemoteAuthorization.layer.pipe(Layer.provideMerge(dependencies))),
      );
      return yield* Effect.gen(function* () {
        const resolver = yield* ConnectionResolver.ConnectionResolver;
        const samples = [];
        for (const phase of ["cold", "warm"] as const) {
          paths.length = 0;
          observedHttpWaitSeconds = 0;
          const started = performance.now();
          const prepared = yield* resolver.prepare({
            target,
            profile: Option.none(),
            enabled: true,
          });
          expect(prepared.socketUrl).toContain("test-ticket");
          samples.push({
            phase,
            seconds: (performance.now() - started) / 1_000,
            observedHttpWaitSeconds,
            paths: [...paths],
          });
        }
        return samples;
      }).pipe(Effect.provide(layer));
    }),
  );

const commandSample = (action: "startTurn" | "interruptTurn", historyDelayMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const historyStarted = yield* Deferred.make<void>();
      let dispatchedAt = 0;
      let observedHistoryWaitSeconds = 0;
      let observedReplyWaitSeconds = 0;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: Effect.fn(
                "RemotePerformance.dispatch",
              )(function* (command: OrchestrationV2Command) {
                dispatchedAt = performance.now();
                expect(command.type).toBe(
                  action === "startTurn" ? "message.dispatch" : "run.interrupt",
                );
                const started = performance.now();
                yield* Effect.sleep(50);
                observedReplyWaitSeconds = (performance.now() - started) / 1_000;
                return { sequence: 1 };
              }),
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          Layer.succeed(ThreadHistoryController, {
            register: unused,
            unregister: Effect.fn("ThreadHistoryController.unregister")(() => Effect.void),
            reconcilePendingWork: Effect.fn("ThreadHistoryController.reconcilePendingWork")(
              () => Effect.void,
            ),
            loadEarlier: Effect.fn("RemotePerformance.loadEarlier")(function* () {
              yield* Deferred.succeed(historyStarted, undefined);
              if (historyDelayMs > 0) {
                const started = performance.now();
                yield* Effect.sleep(historyDelayMs);
                observedHistoryWaitSeconds = (performance.now() - started) / 1_000;
              }
              return { _tag: "loaded" } as const;
            }),
          }),
        ),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const commands = createThreadEnvironmentAtoms(runtime, () => Atom.make(null));
      const history = commands.loadEarlierHistory.run(registry, {
        environmentId: target.environmentId,
        input: { threadId: thread.thread.id },
      });
      yield* Deferred.await(historyStarted);
      const started = performance.now();
      const result = yield* Effect.promise(() =>
        commands[action].run(registry, {
          environmentId: target.environmentId,
          input: {
            threadId: thread.thread.id,
            runId: RunId.make("running-run"),
            message: {
              messageId: MessageId.make("send"),
              role: "user",
              text: "Send",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            dispatchMode: "start",
          },
        }),
      );
      const completeSeconds = (performance.now() - started) / 1_000;
      expect(result._tag).toBe("Success");
      expect(dispatchedAt).toBeGreaterThan(0);
      expect((yield* Effect.promise(() => history))._tag).toBe("Success");
      return {
        dispatchSeconds: (dispatchedAt - started) / 1_000,
        completeSeconds,
        observedHistoryWaitSeconds,
        observedReplyWaitSeconds,
      };
    }),
  );

describe("controlled fixture latency in seconds, not phone or Wi-Fi measurements", () => {
  for (const delayMs of [0, 100]) {
    test(`prepare with ${delayMs}ms injected per HTTP response`, async ({ bench }) => {
      const samples: Effect.Success<ReturnType<typeof prepareSample>>[] = [];
      await bench("actual resolver cold and warm prepare", async () => {
        samples.push(await Effect.runPromise(prepareSample(delayMs)));
      }).run(controlledRunOptions);
      Effect.runSync(
        Effect.log(
          JSON.stringify({ scenario: "prepare", injectedHttpSeconds: delayMs / 1_000, samples }),
        ),
      );
    });
  }
  for (const action of ["startTurn", "interruptTurn"] as const) {
    for (const historyDelayMs of [0, 250]) {
      test(`${action} with ${historyDelayMs}ms injected history and 50ms command reply`, async ({
        bench,
      }) => {
        const samples: Effect.Success<ReturnType<typeof commandSample>>[] = [];
        await bench(`actual thread command scheduler ${action}`, async () => {
          samples.push(await Effect.runPromise(commandSample(action, historyDelayMs)));
        }).run(controlledRunOptions);
        Effect.runSync(
          Effect.log(
            JSON.stringify({
              scenario: action,
              injectedHistorySeconds: historyDelayMs / 1_000,
              injectedCommandSeconds: 0.05,
              samples,
            }),
          ),
        );
      });
    }
  }
});

const delta: Extract<OrchestrationV2DomainEvent, { type: "message.updated" }> = {
  id: EventId.make("delta"),
  type: "message.updated",
  threadId: thread.thread.id,
  occurredAt: v2Now,
  payload: { ...thread.messages[99]!, text: " next", streaming: true },
};

describe("remote message replay", () => {
  for (const count of [100, 1_000]) {
    const loaded = {
      ...thread,
      messages: Array.from({ length: count }, (_, index) => ({
        ...thread.messages[0]!,
        id: MessageId.make(`message-${index}`),
      })),
    };
    const event = {
      ...delta,
      payload: { ...delta.payload, id: loaded.messages.at(-1)!.id },
    };
    const name = `apply 200 message updates to ${count} loaded messages`;
    test(name, async ({ bench }) => {
      await bench(name, () => {
        let current: OrchestrationV2ThreadProjection = loaded;
        for (let index = 0; index < 200; index += 1) {
          current =
            applyOrchestrationV2ProjectionEvent(current, {
              ...event,
              payload: { ...event.payload, text: ` next ${index}` },
            }) ?? current;
        }
      }).run(runOptions);
    });
  }
});
