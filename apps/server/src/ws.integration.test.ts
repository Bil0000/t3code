// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

it("streams hub limits and source removal only to opted-in clients", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hub-stream-"));
  const server = NodeChildProcess.spawn(
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
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, HOME: home, TEST_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = NodeEvents.EventEmitter.once(server, "exit");
  const lines = NodeReadline.createInterface({ input: server.stdout });
  let socket: WebSocket | undefined;
  let errors = "";
  server.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  try {
    let pairingUrl: URL | undefined;
    for await (const line of lines) {
      if (line.startsWith("Pairing URL: ")) {
        pairingUrl = new URL(line.slice("Pairing URL: ".length));
        break;
      }
    }
    expect(pairingUrl, errors).toBeDefined();
    const origin = pairingUrl!.origin;
    const auth = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: new URLSearchParams(pairingUrl!.hash.slice(1)).get("token"),
      }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { cookie },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    expect(ticketResponse.status).toBe(200);
    socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws?wsTicket=${ticket}&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
    );
    const messages = NodeEvents.EventEmitter.on(socket, "message", {
      signal: AbortSignal.timeout(20_000),
    });
    await NodeEvents.EventEmitter.once(socket, "open");

    const send = (id: string, tag: string, payload: unknown) =>
      socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    const sources: unknown[] = [];
    send("1", "subscribeServerConfig", {});
    send("2", "subscribeServerConfig", { usageLimitSources: true });
    for await (const [message] of messages) {
      const response = JSON.parse(message.data);
      if (response._tag === "Chunk")
        socket.send(JSON.stringify({ _tag: "Ack", requestId: response.requestId }));
      if (response._tag === "Exit") expect(response.exit._tag).toBe("Success");
      for (const event of response.values ?? []) {
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
    socket?.close();
    lines.close();
    server.kill("SIGTERM");
    await exited;
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
