// @effect-diagnostics nodeBuiltinImport:off - A real loopback HTTP fixture exercises the browser transport.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PreviewAutomationSnapshot,
  PreviewServerBrowserError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeHttp from "node:http";
import { expect, describe } from "vite-plus/test";
import type { Browser } from "playwright-core";

import * as BrowserEngine from "./BrowserEngine.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewManager from "./Manager.ts";
import { layerTest } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const home = process.env.T3_SERVER_BROWSER_TEST_HOME;
const unsafeBrowserError = new Error("private page text".repeat(5000));
it.effect("removes the server tab even when page and context teardown fail", () =>
  Effect.gen(function* () {
    const browser = yield* ServerBrowser.ServerBrowser;
    const manager = yield* PreviewManager.PreviewManager;
    const threadId = ThreadId.make("failed-close");
    const tab = yield* browser.open({ threadId });
    const error = yield* Effect.flip(
      browser.control({
        threadId,
        tabId: tab.tabId,
        action: { _tag: "press", key: "Enter" },
      }),
    );
    expect(error).toBeInstanceOf(PreviewServerBrowserError);
    expect(error.message).toBe("The server browser action failed.");
    expect(error.cause).toBe(unsafeBrowserError);
    expect(error.message).not.toContain("private page text");
    yield* browser.close({ threadId });
    expect((yield* manager.list({ threadId })).sessions).toHaveLength(0);
  }).pipe(
    Effect.provide(
      Layer.effect(ServerBrowser.ServerBrowser, ServerBrowser.make).pipe(
        Layer.provideMerge(PreviewManager.layer),
        Layer.provide(
          Layer.succeed(BrowserEngine.BrowserEngine, {
            launch: Effect.succeed({
              isConnected: () => true,
              close: () => Promise.resolve(),
              newContext: () =>
                Promise.resolve({
                  close: () => Promise.reject(new Error("Context closed")),
                  newPage: () =>
                    Promise.resolve({
                      on: () => undefined,
                      isClosed: () => false,
                      keyboard: { press: () => Promise.reject(unsafeBrowserError) },
                      setViewportSize: () => Promise.resolve(),
                      close: () => Promise.reject(new Error("Page closed")),
                    }),
                }),
            } as unknown as Browser),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
describe.skipIf(!home)("managed server browser", () => {
  it.live(
    "works without a viewer, keeps state after reconnect, and isolates threads",
    () =>
      Effect.gen(function* () {
        const fixture = NodeHttp.createServer((_request, response) => {
          response.setHeader("content-type", "text/html");
          response.end(
            `<!doctype html><title>Remote browser test</title><h1>Server browser</h1><input id="name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value;document.cookie='saved=yes'">Save</button><p id="result">Ready</p><a href="/next">Next</a>`,
          );
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  fixture.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
        );
        const address = fixture.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const browser = yield* ServerBrowser.ServerBrowser;
        const scope = {
          environmentId: EnvironmentId.make("test-env"),
          threadId: ThreadId.make("test-thread"),
          providerSessionId: "test-provider-session",
          providerInstanceId: ProviderInstanceId.make("test-provider"),
          capabilities: new Set(["preview"] as const),
          issuedAt: 1,
        };
        const invoke = (
          operation: Parameters<typeof browser.invoke>[0]["operation"],
          input: unknown = {},
        ) => browser.invoke({ scope, operation, input });
        const opened = yield* browser.open({
          threadId: scope.threadId,
          url: `http://localhost:${address.port}/`,
        });
        expect(opened.runtime).toBe("server");
        const frame = yield* browser
          .watch({ threadId: scope.threadId, tabId: opened.tabId })
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("10 seconds"));
        expect(frame[0]?.data.length).toBeGreaterThan(100);
        yield* invoke("type", { selector: "#name", text: "Laptop closed", clear: true });
        yield* invoke("click", { selector: "#save" });
        yield* invoke("waitFor", { text: "Laptop closed" });
        const snap = yield* invoke("snapshot");
        const decoded = yield* decodeSnapshot(snap);
        expect(decoded.visibleText).toContain("Laptop closed");
        expect(
          decoded.interactiveElements.find((element) => element.selector === "#name"),
        ).toBeDefined();
        expect(decoded.screenshot.data.length).toBeGreaterThan(100);
        yield* invoke("evaluate", { expression: "console.log('Browser ready')" });
        const diagnostics = yield* decodeSnapshot(yield* invoke("snapshot"));
        expect(diagnostics.consoleEntries.some((entry) => entry.text === "Browser ready")).toBe(
          true,
        );
        expect(diagnostics.networkEntries.some((entry) => entry.status === 200)).toBe(true);
        expect(yield* invoke("evaluate", { expression: "document.cookie" })).toContain("saved=yes");
        expect(yield* invoke("evaluate", { expression: "null" })).toBeNull();
        yield* invoke("evaluate", {
          expression:
            "const button = document.createElement('button'); button.setAttribute('data-testid', 'control\\n\"value'); button.textContent = 'Special'; button.onclick = () => button.textContent = 'Clicked'; document.body.append(button)",
        });
        const special = (yield* decodeSnapshot(yield* invoke("snapshot"))).interactiveElements.find(
          (element) => element.name === "Special",
        );
        expect(special).toBeDefined();
        yield* invoke("click", { selector: special!.selector });
        yield* invoke("waitFor", { text: "Clicked" });
        const reconnected = yield* browser
          .watch({ threadId: scope.threadId, tabId: opened.tabId })
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("10 seconds"));
        expect(reconnected[0]?.data.length).toBeGreaterThan(100);
        yield* invoke("resize", { mode: "freeform", width: 1920, height: 1080 });
        expect((yield* decodeSnapshot(yield* invoke("snapshot"))).screenshot.width).toBe(1280);
        expect(
          (yield* invoke("evaluate", { expression: "'x'.repeat(65000)" }).pipe(
            Effect.asVoid,
            Effect.flip,
          ))._tag,
        ).toBe("PreviewServerBrowserError");
        yield* invoke("click", { selector: "a" });
        const manager = yield* PreviewManager.PreviewManager;
        expect((yield* manager.list({ threadId: scope.threadId })).sessions[0]?.canGoBack).toBe(
          true,
        );
        yield* browser.control({
          threadId: scope.threadId,
          tabId: opened.tabId,
          action: { _tag: "back" },
        });
        yield* invoke("resize", { mode: "freeform", width: 640, height: 480 });
        yield* invoke("setColorScheme", { colorScheme: "dark" });
        expect(
          yield* invoke("evaluate", {
            expression: "matchMedia('(prefers-color-scheme: dark)').matches",
          }),
        ).toBe(true);
        const otherThread = ThreadId.make("isolated-thread");
        const isolated = yield* browser.open({
          threadId: otherThread,
          url: `http://localhost:${address.port}/`,
        });
        expect(
          yield* browser.invoke({
            scope: { ...scope, threadId: otherThread },
            operation: "evaluate",
            tabId: isolated.tabId,
            input: { expression: "document.cookie" },
          }),
        ).toBe("");
        yield* browser.close({ threadId: scope.threadId });
        expect((yield* manager.list({ threadId: scope.threadId })).sessions).toHaveLength(0);
        expect(
          (yield* Effect.flip(
            browser.control({
              threadId: scope.threadId,
              tabId: opened.tabId,
              action: { _tag: "back" },
            }),
          ))._tag,
        ).toBe("PreviewServerBrowserError");
        yield* browser.close({ threadId: otherThread });
      }).pipe(
        Effect.provide(
          ServerBrowser.layer.pipe(
            Layer.provideMerge(PreviewManager.layer),
            Layer.provide(BrowserEngine.layer.pipe(Layer.provide(ProcessRunner.layer))),
            Layer.provide(layerTest(process.cwd(), home!)),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    { timeout: 600000 },
  );
});
