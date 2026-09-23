import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ExtensionError } from "@t3tools/contracts";
import { downloadRehArchive, parseProduct } from "./ExtensionHost.ts";
import { rehAsset } from "./extensionMetadata.ts";

const encodeExtensionError = Schema.encodeEffect(ExtensionError);

it.effect("returns a typed host error for malformed product.json", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(parseProduct("{"));
    expect(failure).toMatchObject({ _tag: "ExtensionError", operation: "host" });
    expect(failure).toHaveProperty("cause");
    expect(yield* encodeExtensionError(failure)).not.toHaveProperty("cause");
  }),
);

it.effect("returns a typed host error for null product.json", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(parseProduct("null"));
    expect(failure).toMatchObject({ _tag: "ExtensionError", operation: "host" });
  }),
);

it.effect("rejects a REH archive that differs from its pinned digest", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reh-integrity-test-" });
    const asset = rehAsset("linux", "x64")!;
    const failure = yield* Effect.flip(
      downloadRehArchive(asset, path.join(directory, "reh.tar.gz")),
    );
    expect(failure).toMatchObject({
      _tag: "ExtensionError",
      operation: "host",
      detail: "The REH archive did not match its pinned SHA-256.",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("changed archive"))),
          ),
        ),
      ),
    ),
  ),
);
