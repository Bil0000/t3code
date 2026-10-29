import { assert, it } from "@effect/vitest";
import { ThreadFolderId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadFolderService from "./ThreadFolderService.ts";

const live = ThreadId.make("thread:live");
const other = ThreadId.make("thread:other");
const deleted = ThreadId.make("thread:deleted");
const reviews = ThreadFolderId.make("folder:reviews");
const fixes = ThreadFolderId.make("folder:fixes");

const layer = ThreadFolderService.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === deleted
            ? { ...liveThreadShell(threadId), deletedAt: liveThreadShell(threadId).createdAt }
            : threadId === live || threadId === other
              ? liveThreadShell(threadId)
              : null,
        ),
    }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [threadId, deletedAt] of [
    [live, null],
    [other, null],
    [deleted, "2026-01-02T00:00:00.000Z"],
  ] as const) {
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "project:test",
        title: threadId,
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: deletedAt,
        payload_json: "{}",
      })}
    `;
  }
});

it.layer(layer)("ThreadFolderService", (it) => {
  it.effect("files threads, moves them between folders, and unfiles them on delete", () =>
    Effect.gen(function* () {
      yield* seedThreads;
      const folders = yield* ThreadFolderService.ThreadFolderService;
      yield* folders.mutate({
        type: "folder.create",
        folderId: reviews,
        name: "Reviews",
        icon: { kind: "lucide", name: "eye", color: "violet" },
        threadIds: [live, other],
      });
      yield* folders.mutate({ type: "folder.create", folderId: fixes, name: "Fixes" });
      yield* folders.mutate({
        type: "folder.move",
        threadIds: [other],
        folderId: fixes,
      });
      const moved = yield* folders.mutate({
        type: "folder.create",
        folderId: reviews,
        name: "Reviews",
        threadIds: [live, other, deleted],
      });
      assert.deepStrictEqual(
        moved.folders.map((folder) => [folder.id, folder.threadIds]),
        [
          [reviews, [live]],
          [fixes, [other]],
        ],
      );
      assert.deepStrictEqual(moved.folders[0]?.icon, {
        kind: "lucide",
        name: "eye",
        color: "violet",
      });

      const renamed = yield* folders.mutate({
        type: "folder.update",
        folderId: fixes,
        name: "Bug fixes",
        icon: null,
      });
      assert.deepStrictEqual(
        renamed.folders.map((folder) => [folder.name, folder.icon]),
        [
          ["Reviews", { kind: "lucide", name: "eye", color: "violet" }],
          ["Bug fixes", null],
        ],
      );

      const unfiled = yield* folders.mutate({
        type: "folder.move",
        threadIds: [live],
        folderId: null,
      });
      assert.deepStrictEqual(unfiled.folders[0]?.threadIds, []);

      const afterDelete = yield* folders.mutate({ type: "folder.delete", folderId: fixes });
      assert.deepStrictEqual(
        afterDelete.folders.map((folder) => folder.id),
        [reviews],
      );
      const refiled = yield* folders.mutate({
        type: "folder.move",
        threadIds: [other],
        folderId: reviews,
      });
      assert.deepStrictEqual(refiled.folders[0]?.threadIds, [other]);
    }),
  );

  it.effect("rejects missing folders and deleted or unknown threads without partial writes", () =>
    Effect.gen(function* () {
      const folders = yield* ThreadFolderService.ThreadFolderService;
      const before = yield* folders.list();
      const missingFolder = yield* folders
        .mutate({ type: "folder.move", threadIds: [live], folderId: ThreadFolderId.make("gone") })
        .pipe(Effect.flip);
      assert.match(missingFolder.message, /does not exist/);
      const deletedThread = yield* folders
        .mutate({
          type: "folder.create",
          folderId: ThreadFolderId.make("folder:partial"),
          name: "Partial",
          threadIds: [live, deleted],
        })
        .pipe(Effect.flip);
      assert.match(deletedThread.message, /does not exist/);
      const unknownUpdate = yield* folders
        .mutate({ type: "folder.update", folderId: ThreadFolderId.make("gone"), name: "x" })
        .pipe(Effect.flip);
      assert.match(unknownUpdate.message, /does not exist/);
      assert.deepStrictEqual(yield* folders.list(), before);
    }),
  );

  it.effect("re-emits the folder list to subscribers after each change", () =>
    Effect.gen(function* () {
      const folders = yield* ThreadFolderService.ThreadFolderService;
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* folders.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* folders.mutate({
        type: "folder.create",
        folderId: ThreadFolderId.make("folder:stream"),
        name: "Stream",
      });
      const emitted = Array.from(yield* Fiber.join(fiber));
      assert.isTrue(emitted[1]?.folders.some((folder) => folder.id === "folder:stream") ?? false);
    }),
  );
});
