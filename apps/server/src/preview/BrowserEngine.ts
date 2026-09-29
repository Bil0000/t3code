import { PreviewServerBrowserError } from "@t3tools/contracts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeModule from "node:module";
import type { Browser } from "playwright-core";
import { lock } from "proper-lockfile";

import * as Config from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export const SERVER_BROWSER_PLAYWRIGHT_VERSION = "1.60.0";
const SDK_INTEGRITY =
  "9bW6zvX/m0lEbgTKJ6YppOKx8H3VOPBMOCFh2irXFOT4BbHgrx5hPjwJYLT40Lu+4qtD36qKc/Hn56StUW57IA==";
const BROWSER_INTEGRITY: Readonly<Record<string, string>> = {
  "chrome-headless-shell-linux64.zip":
    "88817c574c1838a39f88fda0bbd043b4481fd385fb10e92c323e230844d636ce",
  "chromium-headless-shell-linux-arm64.zip":
    "4578d731ef7f2f344ae1d79c0ae2664453fc0848ccaa726856a5e9d34aaa1a0e",
  "chrome-headless-shell-mac-x64.zip":
    "1dabfd7b4ecc5759d3fe90dd3e782ae41659f5dc7c756cf403db104e93c918f0",
  "chrome-headless-shell-mac-arm64.zip":
    "d9014195871a583b0978001a23000aa2cff22e3bb951a92919b7c7775cd14e01",
  "chrome-headless-shell-win64.zip":
    "492367a1cd439403ccb82adeb47b02b17965e3dcd5fbaf2d8fa3eca34941496a",
};
const installLock = Semaphore.makeUnsafe(1);
const isServerBrowserError = Schema.is(PreviewServerBrowserError);

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

export const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
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
      Effect.timeout("2 minutes"),
    );
  const prepare = installLock
    .withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          const compromised = yield* Deferred.make<never, PreviewServerBrowserError>();
          const services = yield* Effect.context<never>();
          yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              lock(directory, {
                realpath: false,
                stale: 120000,
                update: 10000,
                retries: { retries: 1200, factor: 1, minTimeout: 500, maxTimeout: 500 },
                onCompromised: (cause) =>
                  Effect.runSyncWith(services)(
                    Deferred.fail(
                      compromised,
                      new PreviewServerBrowserError({
                        stage: "install",
                        reason: "lock-lost",
                        cause,
                      }),
                    ),
                  ),
              }),
            ),
            (release) => Effect.promise(() => release()).pipe(Effect.ignore),
          );
          return yield* Effect.gen(function* () {
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
                  if (extracted.code !== 0)
                    throw new Error("Could not extract the browser runtime.");
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
                  const archive = yield* Effect.firstSuccessOf(
                    executable.downloadURLs.map((url) =>
                      Effect.gen(function* () {
                        const expected = BROWSER_INTEGRITY[path.basename(new URL(url).pathname)];
                        if (!expected)
                          throw new Error("This browser artifact has no pinned checksum.");
                        const bytes = yield* fetch(url);
                        const digest = yield* Effect.tryPromise(() =>
                          crypto.subtle.digest("SHA-256", bytes),
                        );
                        if (Encoding.encodeHex(new Uint8Array(digest)) !== expected)
                          return yield* new PreviewServerBrowserError({
                            stage: "install",
                            reason: "checksum",
                          });
                        return bytes;
                      }),
                    ),
                  );
                  yield* fs.writeFile(archivePath, archive);
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
          }).pipe(Effect.raceFirst(Deferred.await(compromised)));
        }),
      ),
    )
    .pipe(Effect.timeout("10 minutes"));
  const installationFailure = (cause: unknown) =>
    isServerBrowserError(cause)
      ? cause
      : new PreviewServerBrowserError({ stage: "install", reason: "failed", cause });
  return BrowserEngine.of({
    launch: prepare.pipe(
      Effect.catchDefect((cause) => Effect.fail(installationFailure(cause))),
      Effect.mapError(installationFailure),
      Effect.flatMap(({ sdk, executablePath }) =>
        Effect.tryPromise({
          try: () => sdk.chromium.launch({ executablePath, headless: true }),
          catch: (cause) =>
            new PreviewServerBrowserError({ stage: "launch", reason: "failed", cause }),
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(BrowserEngine, make);
