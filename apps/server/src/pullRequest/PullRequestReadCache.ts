import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { ServerConfig } from "../config.ts";

const CONCURRENT_READS = 512;
type ReadError = PullRequestOperationError | PullRequestUnavailableError;
const entryCodec = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.String,
    expiresAt: Schema.Finite,
    revision: Schema.String,
  }),
);

class Read extends Data.Class<{
  key: string;
  revision: string;
  lookup: Effect.Effect<string, ReadError>;
}> {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Read && that.key === this.key && that.revision === this.revision;
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.key}:${this.revision}`);
  }
}

export class PullRequestReadCache extends Context.Service<
  PullRequestReadCache,
  {
    readonly get: (
      key: string,
      lookup: Effect.Effect<string, ReadError>,
      scopes?: ReadonlyArray<string>,
    ) => Effect.Effect<string, ReadError>;
    readonly invalidate: (scope: string) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestReadCache") {}

export const make = Effect.gen(function* () {
  const backing = yield* KeyValueStore.KeyValueStore;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  let enabled = true;
  const lock = yield* Semaphore.make(CONCURRENT_READS);
  const digest = (key: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(Effect.map(Encoding.encodeHex));
  const revisions = yield* Cache.makeWith(
    (scope: string) =>
      digest(scope).pipe(
        Effect.flatMap((key) => backing.get(`revision:${key}`)),
        Effect.map((value) => value ?? ""),
      ),
    {
      capacity: 2_048,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  const cache = yield* Cache.makeWith(
    Effect.fn("PullRequestReadCache.lookup")(function* (request: Read) {
      const stored = yield* backing.get(request.key).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(entryCodec)(raw)),
        Effect.option,
      );
      if (
        Option.isSome(stored) &&
        stored.value.revision === request.revision &&
        stored.value.expiresAt > clock.currentTimeMillisUnsafe()
      )
        return stored.value;
      const payload = yield* request.lookup;
      const result = {
        payload,
        expiresAt: clock.currentTimeMillisUnsafe() + 60_000,
        revision: request.revision,
      };
      yield* Schema.encodeEffect(entryCodec)(result).pipe(
        Effect.flatMap((encoded) => backing.set(request.key, encoded)),
        Effect.ignore,
      );
      return result;
    }),
    {
      capacity: CONCURRENT_READS,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? Duration.millis(Math.max(0, exit.value.expiresAt - clock.currentTimeMillisUnsafe()))
          : Duration.zero,
    },
  );
  return PullRequestReadCache.of({
    get: Effect.fn("PullRequestReadCache.get")(function* (key, lookup, scopes = []) {
      if (!enabled) return yield* lookup;
      const read = yield* Effect.cached(lookup);
      return yield* Effect.gen(function* () {
        const revision = (yield* Effect.forEach(scopes, (scope) =>
          Cache.get(revisions, scope),
        )).join(":");
        const request = new Read({ key: yield* digest(key), revision, lookup: read });
        return (yield* Cache.get(cache, request)).payload;
      }).pipe(
        Effect.catchTags({ PlatformError: () => read, KeyValueStoreError: () => read }),
        lock.withPermits(1),
      );
    }),
    invalidate: (scope) =>
      Effect.gen(function* () {
        const key = yield* digest(scope);
        const revision = yield* crypto.randomUUIDv4;
        yield* backing.set(`revision:${key}`, revision);
        yield* Cache.set(revisions, scope, revision);
      }).pipe(
        Effect.catch(() => {
          enabled = false;
          return Effect.logWarning("PR cache disabled after clearing failed");
        }),
        Effect.uninterruptible,
        lock.withPermits(CONCURRENT_READS),
      ),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(PullRequestReadCache, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(
          path.join(config.providerStatusCacheDir, "pull-requests"),
        ).pipe(
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("PR cache directory unavailable; using memory cache"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
