import { PreviewServerBrowserError } from "@t3tools/contracts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeModule from "node:module";
import type { Browser } from "playwright-core";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";

export const SERVER_BROWSER_PLAYWRIGHT_VERSION = "1.60.0";
const SDK_INTEGRITY =
  "9bW6zvX/m0lEbgTKJ6YppOKx8H3VOPBMOCFh2irXFOT4BbHgrx5hPjwJYLT40Lu+4qtD36qKc/Hn56StUW57IA==";
const installLock = Semaphore.makeUnsafe(1);

interface PlaywrightBundle {
  registry: {
    registry: {
      findExecutable(
        name: string,
      ): { directory: string; executablePath(): string; downloadURLs: string[] } | undefined;
    };
  };
  utils: { extractZip(file: string, options: { dir: string }): Promise<void> };
}

export class BrowserEngine extends Context.Service<
  BrowserEngine,
  {
    readonly launch: Effect.Effect<Browser, PreviewServerBrowserError>;
  }
>()("t3/preview/BrowserEngine") {}

export const layer = Layer.effect(
  BrowserEngine,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner;
    const http = yield* HttpClient.HttpClient;
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    const directory = path.join(
      config.baseDir,
      "tools",
      "server-browser",
      SERVER_BROWSER_PLAYWRIGHT_VERSION,
    );
    const fetch = (url: string) =>
      http.execute(HttpClientRequest.get(url)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((bytes) => new Uint8Array(bytes)),
      );
    const prepare = installLock
      .withPermit(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          const sdkDirectory = path.join(directory, "sdk");
          const entry = path.join(sdkDirectory, "index.js");
          if (
            !(yield* fs.exists(path.join(sdkDirectory, ".install-complete"))) ||
            !(yield* fs.exists(entry))
          ) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const staging = yield* Effect.acquireRelease(
                  fs.makeTempDirectory({ directory, prefix: ".sdk-" }),
                  (directory) =>
                    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
                );
                const archive = yield* fetch(
                  `https://registry.npmjs.org/playwright-core/-/playwright-core-${SERVER_BROWSER_PLAYWRIGHT_VERSION}.tgz`,
                );
                const digest = yield* Effect.tryPromise(() =>
                  crypto.subtle.digest("SHA-512", archive),
                );
                if (Encoding.encodeBase64(new Uint8Array(digest)) !== SDK_INTEGRITY)
                  throw new Error("The browser runtime checksum did not match.");
                const archivePath = path.join(staging, "sdk.tgz");
                yield* fs.writeFile(archivePath, archive);
                const extracted = yield* runner.run({
                  command: cliArchiveTarCommand(platform, environment),
                  args: ["-xf", archivePath, "-C", staging, "--strip-components=1"],
                  timeout: "1 minute",
                });
                if (extracted.code !== 0) throw new Error("Could not extract the browser runtime.");
                yield* fs.remove(archivePath);
                yield* fs.writeFileString(
                  path.join(staging, ".install-complete"),
                  SERVER_BROWSER_PLAYWRIGHT_VERSION,
                );
                yield* fs.remove(sdkDirectory, { recursive: true, force: true });
                yield* fs.rename(staging, sdkDirectory);
              }),
            );
          }
          const require = NodeModule.createRequire(entry);
          const sdk: typeof import("playwright-core") = yield* Effect.try(() => require(entry));
          const core: PlaywrightBundle = yield* Effect.try(() =>
            require(path.join(sdkDirectory, "lib", "coreBundle.js")),
          );
          const executable = core.registry.registry.findExecutable("chromium-headless-shell");
          if (!executable?.downloadURLs.length)
            throw new Error("This server platform does not support the browser.");
          const browserDirectory = path.join(directory, "chromium");
          const relativeExecutable = path.relative(
            executable.directory,
            executable.executablePath(),
          );
          const executablePath = path.join(browserDirectory, relativeExecutable);
          if (
            !(yield* fs.exists(path.join(browserDirectory, ".install-complete"))) ||
            !(yield* fs.exists(executablePath))
          ) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const staging = yield* Effect.acquireRelease(
                  fs.makeTempDirectory({ directory, prefix: ".chromium-" }),
                  (directory) =>
                    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
                );
                const archivePath = path.join(staging, "browser.zip");
                yield* fs.writeFile(archivePath, yield* fetch(executable.downloadURLs[0]!));
                yield* Effect.tryPromise(() =>
                  core.utils.extractZip(archivePath, { dir: staging }),
                );
                yield* fs.remove(archivePath);
                yield* fs.chmod(path.join(staging, relativeExecutable), 0o755);
                yield* fs.writeFileString(
                  path.join(staging, ".install-complete"),
                  SERVER_BROWSER_PLAYWRIGHT_VERSION,
                );
                yield* fs.remove(browserDirectory, { recursive: true, force: true });
                yield* fs.rename(staging, browserDirectory);
              }),
            );
          }
          return { sdk, executablePath };
        }),
      )
      .pipe(Effect.timeout("10 minutes"));
    return BrowserEngine.of({
      launch: prepare.pipe(
        Effect.flatMap(({ sdk, executablePath }) =>
          Effect.tryPromise(() => sdk.chromium.launch({ executablePath, headless: true })),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(
            new PreviewServerBrowserError({
              message: "Could not prepare the server browser.",
              cause,
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new PreviewServerBrowserError({
              message:
                "Could not start the server browser. Check this environment's network access and browser system libraries, then retry.",
              cause,
            }),
        ),
      ),
    });
  }),
);
