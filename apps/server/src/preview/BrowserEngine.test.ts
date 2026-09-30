import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vite-plus/test";

import * as BrowserEngine from "./BrowserEngine.ts";
import { layerTest, ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";

it.effect("tries the next mirror and rejects a corrupt browser archive before extraction", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      config.baseDir,
      "tools",
      "server-browser",
      BrowserEngine.SERVER_BROWSER_PLAYWRIGHT_VERSION,
    );
    const sdk = path.join(directory, "sdk");
    const urls = [
      "https://primary.test/chrome-headless-shell-linux64.zip",
      "https://mirror.test/chrome-headless-shell-linux64.zip",
    ];
    const marker = path.join(directory, "extracted");
    yield* fs.makeDirectory(path.join(sdk, "lib"), { recursive: true });
    yield* fs.writeFileString(path.join(sdk, ".install-complete"), "1.60.0");
    yield* fs.writeFileString(path.join(sdk, "index.js"), "module.exports = {}");
    const executable = {
      directory: "/browser",
      executablePath: "/browser/chrome",
      downloadURLs: urls,
    };
    const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    const encodedExecutable = yield* encodeJson(executable);
    const encodedMarker = yield* encodeJson(marker);
    yield* fs.writeFileString(
      path.join(sdk, "lib", "coreBundle.js"),
      "const executable = " +
        encodedExecutable +
        "; const file = executable.executablePath; executable.executablePath = () => file; module.exports = { registry: { registry: { findExecutable: () => executable } }, utils: { extractZip: async () => require('node:fs').writeFileSync(" +
        encodedMarker +
        ", 'extracted') } }",
    );
    const requests: string[] = [];
    const result = yield* Effect.gen(function* () {
      const engine = yield* BrowserEngine.BrowserEngine;
      yield* engine.install;
      const [status] = yield* engine.installation.pipe(
        Stream.filter((status) => status.state === "failed"),
        Stream.take(1),
        Stream.runCollect,
      );
      return status!.error!;
    }).pipe(
      Effect.provide(
        Layer.effect(BrowserEngine.BrowserEngine, BrowserEngine.make).pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  requests.push(request.url);
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("corrupt", { status: requests.length === 1 ? 503 : 200 }),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(result._tag).toBe("PreviewServerBrowserError");
    expect(result.stage).toBe("install");
    expect(result.reason).toBe("checksum");
    expect(requests).toEqual(urls);
    expect(yield* fs.exists(marker)).toBe(false);
    expect(yield* fs.exists(path.join(directory, "chromium"))).toBe(false);
    expect(yield* fs.exists(directory + ".lock")).toBe(false);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerTest(process.cwd(), { prefix: "t3-browser-mirrors-" }),
        Layer.mock(ProcessRunner)({}),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect(
  "rejects a corrupt runtime download before extraction and clears the staging directory",
  () =>
    Effect.gen(function* () {
      const engine = yield* BrowserEngine.BrowserEngine;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* engine.install;
      const [status] = yield* engine.installation.pipe(
        Stream.filter((status) => status.state === "failed"),
        Stream.take(1),
        Stream.runCollect,
      );
      const result = status!.error!;
      expect(result._tag).toBe("PreviewServerBrowserError");
      expect(result.stage).toBe("install");
      expect(result.reason).toBe("checksum");
      expect(
        yield* fs.readDirectory(
          path.join(
            config.baseDir,
            "tools",
            "server-browser",
            BrowserEngine.SERVER_BROWSER_PLAYWRIGHT_VERSION,
          ),
        ),
      ).toEqual([]);
    }).pipe(
      Effect.provide(
        BrowserEngine.layer.pipe(
          Layer.provideMerge(layerTest(process.cwd(), { prefix: "t3-browser-install-" })),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(HttpClientResponse.fromWeb(request, new Response("corrupt"))),
              ),
            ),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner)({
              run: () => Effect.die("Must not extract an unverified archive"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("requires confirmation before creating files or downloading a browser", () =>
  Effect.gen(function* () {
    const engine = yield* BrowserEngine.BrowserEngine;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [status] = yield* engine.installation.pipe(Stream.take(1), Stream.runCollect);
    expect(status?.state).toBe("not-installed");
    expect((yield* Effect.flip(engine.launch)).reason).toBe("installation-required");
    expect(yield* fs.exists(path.join(config.baseDir, "tools", "server-browser"))).toBe(false);
  }).pipe(
    Effect.provide(
      BrowserEngine.layer.pipe(
        Layer.provideMerge(layerTest(process.cwd(), { prefix: "t3-browser-consent-" })),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Must not download without confirmation")),
          ),
        ),
        Layer.provide(
          Layer.mock(ProcessRunner)({
            run: () => Effect.die("Must not extract without confirmation"),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("keeps an explicit installation alive after its caller closes and supports retry", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let requests = 0;
    yield* Effect.gen(function* () {
      const engine = yield* BrowserEngine.BrowserEngine;
      yield* Effect.scoped(engine.install);
      yield* Deferred.await(requested);
      yield* engine.install;
      const [installing] = yield* engine.installation.pipe(Stream.take(1), Stream.runCollect);
      expect(installing?.state).toBe("installing");
      expect(installing?.stage).toBe("runtime");
      expect(requests).toBe(1);
      yield* Deferred.succeed(release, undefined);
      const [failed] = yield* engine.installation.pipe(
        Stream.filter((status) => status.state === "failed"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(failed?.error?.reason).toBe("checksum");
      yield* engine.install;
      yield* engine.installation.pipe(
        Stream.filter((status) => status.state === "failed"),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(requests).toBe(2);
    }).pipe(
      Effect.provide(
        BrowserEngine.layer.pipe(
          Layer.provide(layerTest(process.cwd(), { prefix: "t3-browser-background-install-" })),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.gen(function* () {
                  requests++;
                  yield* Deferred.succeed(requested, undefined);
                  yield* Deferred.await(release);
                  return HttpClientResponse.fromWeb(request, new Response("corrupt"));
                }),
              ),
            ),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner)({
              run: () => Effect.die("Must not extract a corrupt archive"),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);
