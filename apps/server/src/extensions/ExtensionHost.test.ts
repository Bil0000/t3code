import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExtensionError } from "@t3tools/contracts";
import { parseProduct } from "./ExtensionHost.ts";

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
