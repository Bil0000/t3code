import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { RpcSerialization, type RpcMessage } from "effect/unstable/rpc";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const decodeConfigEvent = Schema.decodeUnknownSync(ServerConfigStreamEvent);

it.effect("streams hub limits and source removal only to opted-in clients", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-stream-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const server = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import * as Effect from 'effect/Effect';
      import * as NodeServices from '@effect/platform-node/NodeServices';
      import { layerTest, ServerConfig } from './src/config.ts';
      import { runServer } from './src/server.ts';
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const config = yield* ServerConfig;
        yield* runServer.pipe(Effect.provideService(ServerConfig, {
          ...config, noBrowser: true, startupPresentation: 'headless'
        }));
      })).pipe(Effect.provide(layerTest(process.cwd(), process.env.TEST_HOME)), Effect.provide(NodeServices.layer)));
    `,
        ],
        {
          cwd: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
          env: { HOME: home, TEST_HOME: home },
          extendEnv: true,
          stdin: "ignore",
          stderr: "inherit",
        },
      ),
    );
    const line = yield* server.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("Pairing URL: ")),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    const pairingUrl = new URL(line.slice("Pairing URL: ".length));
    const origin = pairingUrl.origin;
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const tokenResponse = yield* client.post(`${origin}/oauth/token`, {
      body: HttpBody.urlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: new URLSearchParams(pairingUrl.hash.slice(1)).get("token")!,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
      }),
    });
    const token = yield* HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)(tokenResponse);
    const ticketResponse = yield* client.post(`${origin}/api/auth/websocket-ticket`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const { ticket } =
      yield* HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)(ticketResponse);
    yield* Effect.promise(async () => {
      const socket = new WebSocket(
        `${origin.replace("http:", "ws:")}/ws?wsTicket=${ticket}&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
      );
      try {
        const messages = NodeEvents.EventEmitter.on(socket, "message", {
          signal: AbortSignal.timeout(20_000),
        });
        await NodeEvents.EventEmitter.once(socket, "open");

        const wire = RpcSerialization.json.makeUnsafe();
        const send = (id: string, tag: string, payload: unknown) =>
          socket.send(wire.encode({ _tag: "Request", id, tag, payload, headers: [] })!);
        const sources: unknown[] = [];
        send("1", "subscribeServerConfig", {});
        send("2", "subscribeServerConfig", { usageLimitSources: true });
        for await (const [message] of messages) {
          const response = wire.decode(message.data)[0] as RpcMessage.FromServerEncoded;
          if (response._tag === "Exit") {
            expect(response.exit._tag).toBe("Success");
            continue;
          }
          if (response._tag !== "Chunk")
            throw new Error(`Unexpected RPC response: ${response._tag}`);
          socket.send(wire.encode({ _tag: "Ack", requestId: response.requestId })!);
          for (const value of response.values) {
            const event = decodeConfigEvent(value);
            if (event.type !== "usageLimitSourcesUpdated") continue;
            expect(response.requestId).toBe("2");
            sources.push(event.payload.sources);
            if (sources.length === 1) {
              expect(event.payload.sources).toEqual([]);
              send("3", "server.updateSettings", {
                patch: {
                  usageLimitSources: {
                    hub: {
                      kind: "cliproxy",
                      label: "Test hub",
                      url: "http://127.0.0.1:1",
                      managementKey: "",
                      enabled: true,
                    },
                  },
                },
              });
              continue;
            }
            if (event.payload.sources.length > 0) {
              expect(event.payload.sources).toEqual([
                expect.objectContaining({
                  id: "hub",
                  label: "Test hub",
                  accounts: [],
                  error: "No management key configured.",
                }),
              ]);
              send("4", "server.updateSettings", { patch: { usageLimitSources: { hub: null } } });
            } else {
              expect(sources).toHaveLength(3);
              return;
            }
          }
        }
        throw new Error("Hub limits stream ended before source removal");
      } finally {
        socket.close();
      }
    });
  }).pipe(Effect.scoped, Effect.provide([NodeHttpClient.layerNodeHttp, NodeServices.layer])),
);
