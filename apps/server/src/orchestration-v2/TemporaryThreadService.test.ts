import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as TemporaryThreadService from "./TemporaryThreadService.ts";

const threadId = ThreadId.make("temporary");
const childId = ThreadId.make("temporary-child");
const first = { sessionId: "session", clientId: "first" };
const second = { sessionId: "session", clientId: "second" };
const views = (
  threadIds: ReadonlyArray<ThreadId>,
  generation = 1,
  background = false,
  viewId = "view",
) => ({
  viewId,
  generation,
  threadIds,
  background,
});

const setup = Effect.gen(function* () {
  const temporary = new Set<ThreadId>();
  const discarded = new Set<ThreadId>();
  const operations: Array<string> = [];
  const changes = yield* PubSub.unbounded<{
    type: "registered" | "kept" | "discarding" | "discarded";
    threadIds: ReadonlyArray<ThreadId>;
    generation: string;
  }>();
  const cleanupStarted = yield* Deferred.make<void>();
  const cleanupRelease = yield* Deferred.make<void>();
  let delayCleanup = false;
  let rejectCleanup = false;
  const keepStarted = yield* Deferred.make<void>();
  const keepRelease = yield* Deferred.make<void>();
  let delayKeep = false;
  let rejectKeep = false;
  const storage = TemporaryThreadStorage.TemporaryThreadStorage.of({
    register: ({ threadId: id }) =>
      Effect.gen(function* () {
        temporary.add(id);
        yield* PubSub.publish(changes, {
          type: "registered",
          threadIds: [id],
          generation: "memory",
        });
      }),
    isTemporary: (id) => Effect.sync(() => temporary.has(id)),
    isDiscarded: (id) => Effect.sync(() => discarded.has(id)),
    family: () => Effect.sync(() => [...temporary]),
    markDiscarding: () =>
      Effect.sync(() => {
        operations.push("mark");
      }),
    keep: ({ threadId: id }) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(keepStarted, undefined);
        if (delayKeep) yield* Deferred.await(keepRelease);
        if (rejectKeep)
          return yield* new TemporaryThreadStorage.TemporaryThreadStorageError({
            operation: "keep",
            threadId: id,
            cause: new Error("failure"),
          });
        operations.push("keep");
        temporary.clear();
      }),
    discard: () =>
      Effect.sync(() => {
        operations.push("discard");
        for (const id of temporary) discarded.add(id);
        temporary.clear();
      }),
    generation: () => Effect.succeed("memory"),
    subscribeThreadRunUpdates: () => Effect.succeed(Stream.empty),
    changes: Stream.fromPubSub(changes),
  });
  const cleanup = TemporaryThreadService.TemporaryThreadCleanup.of({
    stopAndTeardown: (ids) =>
      Effect.gen(function* () {
        operations.push(`stop:${ids.join(",")}`);
        yield* Deferred.succeed(cleanupStarted, undefined);
        if (delayCleanup) yield* Deferred.await(cleanupRelease);
        if (rejectCleanup)
          return yield* new TemporaryThreadService.TemporaryThreadServiceError({
            operation: "discard",
            cause: "cleanup failure",
          });
      }),
  });
  const serviceLayer = TemporaryThreadService.layer.pipe(
    Layer.provide(TemporaryThreadService.layerState),
    Layer.provide(Layer.succeed(TemporaryThreadStorage.TemporaryThreadStorage, storage)),
    Layer.provide(Layer.succeed(TemporaryThreadService.TemporaryThreadCleanup, cleanup)),
  );
  return {
    storage,
    operations,
    temporary,
    discarded,
    serviceLayer,
    cleanupStarted,
    cleanupRelease,
    delayCleanup: () => {
      delayCleanup = true;
    },
    rejectCleanup: (reject = true) => {
      rejectCleanup = reject;
    },
    keepStarted,
    keepRelease,
    delayKeep: () => {
      delayKeep = true;
    },
    rejectKeep: () => {
      rejectKeep = true;
    },
  };
});

it.effect("only the last explicit view leave stops and discards the entire family", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* fixture.storage.register({ threadId: childId, parentThreadId: threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.updateViews(second, views([threadId], 1, false, "second-view"));
      yield* service.updateViews(first, views([], 2));
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(second, views([], 2, false, "second-view"));
      assert.deepEqual(fixture.operations, ["mark", "stop:temporary,temporary-child", "discard"]);
      assert.isTrue(fixture.discarded.has(childId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("ignores stale view updates and rejects a view claimed by another session", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId], 2));
      yield* service.updateViews(first, views([], 1));
      assert.deepEqual(fixture.operations, []);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            service.updateViews({ ...second, sessionId: "other-session" }, views([], 3)),
          ),
        ),
      );
      yield* service.updateViews(first, views([], 3));
      assert.isTrue(fixture.discarded.has(threadId));
      yield* service.updateViews(first, views([threadId], 2));
      assert.isFalse(fixture.temporary.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("gives disconnected foreground views 30 seconds to reconnect", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("29 seconds");
      assert.isFalse(fixture.discarded.has(threadId));
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("retains a background view through suspension until explicit leave", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId], 1, true));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("reconnect cancels the old foreground expiry", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("20 seconds");
      yield* service.updateViews(first, views([threadId], 2));
      yield* TestClock.adjust("20 seconds");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 3));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("does not acknowledge Keep or discard while durable save is pending", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.delayKeep();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      const saving = yield* service
        .keep({ threadId, commandId: CommandId.make("keep") })
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.keepStarted);
      assert.isTrue(fixture.temporary.has(threadId));
      const leaving = yield* service.updateViews(first, views([], 2)).pipe(Effect.forkChild);
      yield* Deferred.succeed(fixture.keepRelease, undefined);
      assert.deepEqual(yield* Fiber.join(saving), { threadId });
      yield* Fiber.join(leaving);
      assert.deepEqual(fixture.operations, ["keep"]);
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("failed Keep leaves the thread temporary and still discardable", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.rejectKeep();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(service.keep({ threadId, commandId: CommandId.make("keep") })),
        ),
      );
      assert.isTrue(fixture.temporary.has(threadId));
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a view can own the planned thread before creation arrives", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* service.updateViews(first, views([threadId]));
      yield* fixture.storage.register({ threadId });
      yield* TestClock.adjust("31 seconds");
      assert.isTrue(fixture.temporary.has(threadId));
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("drops ownership with no view after the creation grace", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      yield* fixture.storage.register({ threadId });
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a new reload view protects the thread when the old lease expires", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* service.updateViews(second, views([threadId], 1, false, "reload"));
      yield* TestClock.adjust("31 seconds");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(second, views([], 2, false, "reload"));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect(
  "reconnect can replace its socket identity and a late old disconnect cannot close it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* TemporaryThreadService.TemporaryThreadService;
        const reconnected = { ...first, clientId: "new-socket" };
        yield* fixture.storage.register({ threadId });
        yield* service.updateViews(first, views([threadId]));
        yield* service.disconnectClient(first);
        yield* service.updateViews(reconnected, views([threadId], 2));
        yield* service.disconnectClient(first);
        yield* TestClock.adjust("31 seconds");
        assert.deepEqual(fixture.operations, []);
        yield* service.updateViews(reconnected, views([], 3));
        assert.isTrue(fixture.discarded.has(threadId));
      }).pipe(Effect.provide(fixture.serviceLayer));
    }),
);

it.effect("finishes explicit leave cleanup when its RPC caller disconnects", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.delayCleanup();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      const leaving = yield* service.updateViews(first, views([], 2)).pipe(Effect.forkChild);
      yield* Deferred.await(fixture.cleanupStarted);
      leaving.interruptUnsafe();
      yield* Deferred.succeed(fixture.cleanupRelease, undefined);
      yield* Fiber.await(leaving);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each([2, 3])("retries failed last-view cleanup at generation %s", (generation) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* fixture.storage.register({ threadId: childId, parentThreadId: threadId });
      yield* service.updateViews(first, views([threadId]));
      fixture.rejectCleanup();
      assert.equal((yield* Effect.exit(service.updateViews(first, views([], 2))))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(service.updateViews(first, views([], generation))))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(service.keep({ threadId: childId, commandId: CommandId.make("keep") })))
          ._tag,
        "Failure",
      );
      assert.isTrue(fixture.temporary.has(threadId));
      fixture.rejectCleanup(false);
      yield* service.updateViews(first, views([childId], generation));
      assert.deepEqual(fixture.operations, [
        "mark",
        "stop:temporary,temporary-child",
        "mark",
        "stop:temporary,temporary-child",
        "mark",
        "stop:temporary,temporary-child",
        "discard",
      ]);
      assert.isTrue(fixture.discarded.has(threadId));
      assert.isTrue(fixture.discarded.has(childId));
      assert.isFalse(fixture.temporary.has(childId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each(["disconnect", "unowned"])("retries failed %s expiry cleanup", (expiry) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      if (expiry === "disconnect") {
        yield* service.updateViews(first, views([threadId]));
        yield* service.disconnectClient(first);
      }
      fixture.rejectCleanup();
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.temporary.has(threadId));
      fixture.rejectCleanup(false);
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(fixture.discarded.has(threadId));
      assert.deepEqual(fixture.operations, [
        "mark",
        "stop:temporary",
        "mark",
        "stop:temporary",
        "discard",
      ]);
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);
