import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  PreviewAutomationBroker,
  type PreviewAutomationInvokeInput,
} from "../mcp/PreviewAutomationBroker.ts";
import * as Snapshot from "./Snapshot.ts";

const tabId = PreviewTabId.make("text-tab");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const scope = {
  environmentId: EnvironmentId.make("text-environment"),
  threadId: ThreadId.make("text-thread"),
  providerSessionId: "text-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-text-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makePage = (initialText: string) => {
  let text = initialText;
  let reads = 0;
  const timers = new Set<() => void>();
  const requests: PreviewAutomationInvokeInput[] = [];
  const context = NodeVM.createContext({
    document: {
      body: {
        get innerText() {
          reads++;
          return text;
        },
      },
    },
    location: { href: "https://example.test/page" },
    setTimeout: (callback: () => void) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  });
  const page = {
    context,
    timers,
    requests,
    reads: () => reads,
    available: true,
    setText: (value: string) => {
      text = value;
    },
    beforeChunk: undefined as (() => void) | undefined,
    chunkGate: undefined as Effect.Effect<void> | undefined,
    disposeGate: undefined as Effect.Effect<void> | undefined,
    broker: undefined as PreviewAutomationBroker["Service"] | undefined,
  };
  const invoke = <A>(request: PreviewAutomationInvokeInput) =>
    Effect.gen(function* () {
      requests.push(request);
      if (request.operation === "status") {
        return {
          available: page.available,
          visible: true,
          tabId,
          url: "https://example.test/page",
          title: "Page",
          loading: false,
        } as A;
      }
      if (request.operation === "snapshot") {
        expect(request.tabId).toBe(tabId);
        return {
          url: "https://example.test/page",
          title: "Page",
          loading: false,
          visibleText: "Page",
          interactiveElements: [],
          accessibilityTree: {},
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          screenshot: {
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
            width: 10,
            height: 5,
          },
        } as A;
      }
      expect(request.operation).toBe("evaluate");
      expect(request.tabId).toBe(tabId);
      expect(request.timeoutMs).toBeUndefined();
      const expression = (request.input as { expression: string }).expression;
      if (expression.includes("let end")) {
        page.beforeChunk?.();
        if (page.chunkGate) yield* page.chunkGate;
      }
      const value = yield* Effect.try({
        try: () => {
          const value = NodeVM.runInContext(expression, context) as A;
          expect(Buffer.byteLength(encodeJson(value), "utf8")).toBeLessThan(32_000);
          return value;
        },
        catch: () => new PreviewAutomationNoAvailableHostError({ ...scope, operation: "evaluate" }),
      });
      if (expression.includes("capture?.dispose()") && page.disposeGate) {
        yield* page.disposeGate;
      }
      return value;
    });
  page.broker = PreviewAutomationBroker.of({
    invoke,
    connect: () => Effect.die("unused"),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
  });
  return page;
};

const runExport = (page: ReturnType<typeof makePage>, target?: PreviewTabId) =>
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.PreviewSnapshot;
    return yield* snapshot.withSnapshot(
      { scope, saveText: true, ...(target === undefined ? {} : { tabId: target }) },
      ({ textExport }) => Effect.succeed(textExport!),
    );
  }).pipe(
    Effect.provide(Snapshot.layer),
    Effect.provideService(PreviewAutomationBroker, page.broker!),
  );
const assertClean = (page: ReturnType<typeof makePage>) => {
  expect(page.timers.size).toBe(0);
  expect(
    Object.getOwnPropertyNames(page.context).filter((name) => name.startsWith("__t3_text_export_")),
  ).toEqual([]);
};

it.effect("exports all loaded text through bounded V1 evaluate chunks and pins the tab", () =>
  Effect.gen(function* () {
    const text = "\u0001".repeat(70_000) + "loaded end";
    const page = makePage(text);
    const saved = yield* runExport(page);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(saved.textPath)).toBe(text);
    expect(saved).toMatchObject({
      totalChars: text.length,
      sizeBytes: Buffer.byteLength(text),
      tabId,
      url: "https://example.test/page",
    });
    expect(page.reads()).toBe(1);
    expect(page.requests[0]?.operation).toBe("status");
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps Unicode pairs intact at chunk boundaries", () =>
  Effect.gen(function* () {
    const text = "a".repeat(4095) + "😀中文" + "b".repeat(4093) + "🚀";
    const page = makePage(text);
    const saved = yield* runExport(page, tabId);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(saved.textPath)).toBe(text);
    expect(saved.sizeBytes).toBe(Buffer.byteLength(text));
    expect(page.requests.some((request) => request.operation === "status")).toBe(false);
    expect(page.requests.at(-1)?.operation).toBe("snapshot");
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("writes an empty loaded page without reading chunks", () =>
  Effect.gen(function* () {
    const page = makePage("");
    const saved = yield* runExport(page);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(saved.textPath)).toBe("");
    expect(saved).toMatchObject({ totalChars: 0, sizeBytes: 0 });
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("freezes captured text while the page changes", () =>
  Effect.gen(function* () {
    const text = "original ".repeat(9000);
    const page = makePage(text);
    page.beforeChunk = () => {
      page.setText("changed page");
      const key = Object.getOwnPropertyNames(page.context).find((name) =>
        name.startsWith("__t3_text_export_"),
      )!;
      expect(
        NodeVM.runInContext(`Object.isFrozen(globalThis[${encodeJson(key)}])`, page.context),
      ).toBe(true);
    };
    const saved = yield* runExport(page);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(saved.textPath)).toBe(text);
    expect(page.reads()).toBe(1);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["navigation", "expiry"] as const)("removes partial text after %s", (failure) =>
  Effect.gen(function* () {
    const page = makePage("text ".repeat(20_000));
    let chunks = 0;
    page.beforeChunk = () => {
      if (++chunks !== 2) return;
      if (failure === "navigation")
        NodeVM.runInContext("location.href = 'https://other.test/'", page.context);
      else [...page.timers][0]!();
    };
    const result = yield* Effect.result(runExport(page));
    expect(result._tag).toBe("Failure");
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("cleans the browser capture when the artifacts directory cannot be created", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(config.browserArtifactsDir, "existing file");
    const page = makePage("text");
    const result = yield* Effect.result(runExport(page));
    expect(result._tag).toBe("Failure");
    expect(yield* fs.readFileString(config.browserArtifactsDir)).toBe("existing file");
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("removes a partial file when writing the next chunk fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const page = makePage("text ".repeat(3000));
    let writes = 0;
    const failingFs = FileSystem.FileSystem.of({
      ...fs,
      open: (filePath, options) =>
        fs.open(filePath, options).pipe(
          Effect.map((file) => ({
            ...file,
            writeAll: (bytes) =>
              ++writes === 2
                ? fs.writeFileString(config.browserArtifactsDir, "fails on a directory")
                : file.writeAll(bytes),
          })),
        ),
    });
    const result = yield* Effect.result(
      runExport(page).pipe(Effect.provideService(FileSystem.FileSystem, failingFs)),
    );
    expect(result._tag).toBe("Failure");
    expect(writes).toBe(2);
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not create a capture when the resolved tab is unavailable", () =>
  Effect.gen(function* () {
    const page = makePage("text");
    page.available = false;
    const result = yield* Effect.result(runExport(page));
    expect(result._tag).toBe("Failure");
    expect(page.requests).toHaveLength(1);
    expect(page.reads()).toBe(0);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("removes partial files and the browser capture on cancellation", () =>
  Effect.gen(function* () {
    const enteredChunk = yield* Deferred.make<void>();
    const page = makePage("text ".repeat(2000));
    page.chunkGate = Deferred.succeed(enteredChunk, undefined).pipe(Effect.andThen(Effect.never));
    const fiber = yield* Effect.forkChild(runExport(page));
    yield* Deferred.await(enteredChunk);
    yield* Fiber.interrupt(fiber);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("removes the completed file when cancellation occurs during browser cleanup", () =>
  Effect.gen(function* () {
    const enteredDispose = yield* Deferred.make<void>();
    const releaseDispose = yield* Deferred.make<void>();
    const page = makePage("completed text");
    page.disposeGate = Deferred.succeed(enteredDispose, undefined).pipe(
      Effect.andThen(Deferred.await(releaseDispose)),
    );
    const fiber = yield* Effect.forkChild(runExport(page));
    yield* Deferred.await(enteredDispose);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toHaveLength(1);
    const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseDispose, undefined);
    yield* Fiber.join(interruption);
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
    assertClean(page);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["failure", "cancellation"] as const)(
  "removes its export after snapshot result delivery %s",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
      const existing = path.join(config.browserArtifactsDir, "existing.txt");
      yield* fs.writeFileString(existing, "keep this file");
      const enteredUse = yield* Deferred.make<void>();
      const page = makePage("completed text");
      const delivery = Effect.gen(function* () {
        const snapshots = yield* Snapshot.PreviewSnapshot;
        return yield* snapshots.withSnapshot({ scope, saveText: true }, ({ textExport }) =>
          Effect.gen(function* () {
            expect(yield* fs.readFileString(textExport!.textPath)).toBe("completed text");
            yield* Deferred.succeed(enteredUse, undefined);
            return yield* outcome === "failure" ? Effect.fail("delivery failed") : Effect.never;
          }),
        );
      }).pipe(
        Effect.provide(Snapshot.layer),
        Effect.provideService(PreviewAutomationBroker, page.broker!),
      );
      const fiber = yield* Effect.forkChild(delivery);
      yield* Deferred.await(enteredUse);
      if (outcome === "cancellation") yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual(["existing.txt"]);
      expect(yield* fs.readFileString(existing)).toBe("keep this file");
      assertClean(page);
    }).pipe(Effect.provide(TestLayer)),
);
