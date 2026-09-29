import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
      return yield* Effect.flip((yield* BrowserEngine.BrowserEngine).launch);
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
      const result = yield* Effect.flip(engine.launch);
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
