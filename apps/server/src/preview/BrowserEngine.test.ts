import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vite-plus/test";

import * as BrowserEngine from "./BrowserEngine.ts";
import { layerTest, ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";

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
