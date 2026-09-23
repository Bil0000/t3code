import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { parseProduct } from "./ExtensionHost.ts";

it.effect("returns a typed host error for malformed product.json", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(parseProduct("{"));
    expect(failure).toMatchObject({ _tag: "ExtensionError", operation: "host" });
  }),
);
