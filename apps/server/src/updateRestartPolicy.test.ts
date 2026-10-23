import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { make, UpdateRestartPolicyError } from "./updateRestartPolicy.ts";

it.layer(NodeServices.layer)("update restart policy", (it) => {
  it.effect("vetoes only interrupted run IDs across restarts and ignores command replay", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "policy.json");
      const original = RunId.make("original");
      const queued = RunId.make("queued-continuation-source");
      const later = RunId.make("later");
      const first = yield* make(file);
      yield* first.set("update", false);
      assert.isFalse(yield* first.isVetoed(original));
      yield* first.capture([original], "shutdown");
      assert.isTrue(yield* first.isVetoed(original));
      const restarted = yield* make(file);
      yield* restarted.set("update", true);
      yield* restarted.capture([original, queued], "startup");
      assert.isTrue(yield* restarted.isVetoed(original));
      assert.isTrue(yield* restarted.isVetoed(queued));
      yield* restarted.set("update", false);
      yield* restarted.capture([later], "shutdown");
      assert.isFalse(yield* restarted.isVetoed(later));
      const third = yield* make(file);
      yield* third.capture([later], "startup");
      assert.isFalse(yield* third.isVetoed(later));
      assert.isTrue(yield* third.isVetoed(original));
    }),
  );

  it.effect("vetoes a new run when the backend dies before shutdown preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "policy.json");
      const startedAfterAck = RunId.make("started-after-ack");
      const first = yield* make(file);
      yield* first.set("forced-update", false);
      const restarted = yield* make(file);
      yield* restarted.capture([startedAfterAck], "startup");
      assert.isTrue(yield* restarted.isVetoed(startedAfterAck));
      yield* restarted.set("forced-update", true);
      assert.isTrue(yield* restarted.isVetoed(startedAfterAck));
    }),
  );

  it.effect("keeps a live startup arm active until that backend stops", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "policy.json");
      const run = RunId.make("started-after-recovery");
      const policy = yield* make(file);
      yield* policy.set("starting-backend-update", false);
      yield* policy.capture([], "startup");
      yield* policy.capture([run], "shutdown");
      assert.isTrue(yield* policy.isVetoed(run));
    }),
  );

  it.effect("disarms an update that did not stop its original backend", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "policy.json");
      const run = RunId.make("unrelated-crash");
      const policy = yield* make(file);
      yield* policy.set("refused-update", false);
      yield* policy.set("other-update", true);
      yield* policy.set("refused-update", true);
      yield* policy.set("refused-update", false);
      const restarted = yield* make(file);
      yield* restarted.capture([run], "startup");
      assert.isFalse(yield* restarted.isVetoed(run));
    }),
  );
  it.effect(
    "prunes closed runs only after recovery and their continuation effects no longer need them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const file = path.join(directory, "policy.json");
        const obsolete = RunId.make("obsolete");
        const eligible = RunId.make("eligible");
        const pending = RunId.make("pending");
        const running = RunId.make("running");
        const failed = RunId.make("failed");
        const first = yield* make(file);
        yield* first.set("finished-update", false);
        yield* first.capture([obsolete, eligible, pending, running, failed], "shutdown");
        const restarted = yield* make(file);
        const continuationPending = (id: RunId) => Effect.succeed(id === pending || id === running);
        yield* restarted.set("live-update", false);
        yield* restarted.capture([eligible], "startup", continuationPending);
        assert.isFalse(yield* restarted.isVetoed(obsolete));
        assert.isFalse(yield* restarted.isVetoed(failed));
        for (const id of [eligible, pending, running]) assert.isTrue(yield* restarted.isVetoed(id));
        const saved = JSON.parse(yield* fs.readFileString(file)) as {
          entries: Array<{ requestId: string; runIds: RunId[]; pending: boolean }>;
        };
        assert.deepEqual(
          saved.entries.find((entry) => entry.requestId === "finished-update")?.runIds,
          [eligible, pending, running],
        );
        assert.isTrue(saved.entries.find((entry) => entry.requestId === "live-update")?.pending);
        const third = yield* make(file);
        yield* third.capture([eligible], "startup", continuationPending);
        for (const id of [eligible, pending, running]) assert.isTrue(yield* third.isVetoed(id));
        yield* third
          .capture([], "startup", () =>
            Effect.fail(new UpdateRestartPolicyError({ cause: "read failed" })),
          )
          .pipe(Effect.flip);
        assert.isTrue(yield* third.isVetoed(pending));
        yield* third.capture([], "startup", () => Effect.succeed(false));
        const cleaned = JSON.parse(yield* fs.readFileString(file)) as { entries: unknown[] };
        assert.deepEqual(cleaned.entries, []);
        yield* third.set("live-update", false);
        const later = RunId.make("later-run");
        yield* third.capture([later], "shutdown");
        assert.isFalse(yield* third.isVetoed(later));
        const fourth = yield* make(file);
        yield* fourth.set("live-update", false);
        yield* fourth.capture([later], "shutdown");
        assert.isFalse(yield* fourth.isVetoed(later));
        yield* fourth.set("new-update", false);
        yield* fourth.capture([later], "shutdown");
        assert.isTrue(yield* fourth.isVetoed(later));
      }),
  );
});
