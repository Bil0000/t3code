import {
  MAX_THREAD_FOLDERS,
  StoredProjectIcon,
  type ThreadFolder,
  ThreadFolderError,
  type ThreadFolderId,
  type ThreadFolderListResult,
  type ThreadFolderMutation,
  type ThreadFolderMutationResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class ThreadFolderService extends Context.Service<
  ThreadFolderService,
  {
    readonly list: () => Effect.Effect<ThreadFolderListResult, ThreadFolderError>;
    readonly subscribeList: () => Stream.Stream<ThreadFolderListResult, ThreadFolderError>;
    readonly mutate: (
      mutation: ThreadFolderMutation,
    ) => Effect.Effect<ThreadFolderMutationResult, ThreadFolderError>;
  }
>()("t3/threadFolders/ThreadFolderService") {}

interface FolderRow {
  readonly folder_id: ThreadFolderId;
  readonly name: string;
  readonly icon_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly thread_id: ThreadId;
  readonly folder_id: ThreadFolderId;
}

const decodeIcon = Schema.decodeUnknownOption(Schema.fromJsonString(StoredProjectIcon));
const encodeIcon = Schema.encodeSync(Schema.fromJsonString(StoredProjectIcon));

const folderError = (message: string, options?: { folderId?: ThreadFolderId; cause?: unknown }) =>
  new ThreadFolderError({
    message,
    ...(options?.folderId === undefined ? {} : { folderId: options.folderId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  const writes = yield* Semaphore.make(1);

  const readFolders = Effect.gen(function* () {
    const rows = yield* sql<FolderRow>`
      SELECT folder_id, name, icon_json, created_at, updated_at
      FROM thread_folders
      ORDER BY created_at ASC, rowid ASC
    `;
    const members = yield* sql<MemberRow>`
      SELECT members.thread_id, members.folder_id
      FROM thread_folder_members AS members
      JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = members.thread_id AND threads.deleted_at IS NULL
      ORDER BY members.added_at ASC, members.rowid ASC
    `;
    const threadIdsByFolder = new Map<ThreadFolderId, Array<ThreadId>>();
    for (const member of members) {
      const list = threadIdsByFolder.get(member.folder_id) ?? [];
      list.push(member.thread_id);
      threadIdsByFolder.set(member.folder_id, list);
    }
    return rows.map((row): ThreadFolder => ({
      id: row.folder_id,
      name: row.name,
      icon: row.icon_json === null ? null : Option.getOrNull(decodeIcon(row.icon_json)),
      threadIds: threadIdsByFolder.get(row.folder_id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });

  const list: ThreadFolderService["Service"]["list"] = () =>
    readFolders.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((folders) => ({ folders })),
      Effect.mapError((cause) => folderError("Could not list thread folders.", { cause })),
    );

  const subscribeList: ThreadFolderService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const requireLiveThreads = Effect.fn("ThreadFolderService.requireLiveThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    for (const threadId of new Set(threadIds)) {
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) => folderError(`Could not read thread ${threadId}.`, { cause })),
        );
      if (shell === null || shell.deletedAt !== null) {
        return yield* folderError(`Thread ${threadId} does not exist.`);
      }
    }
  });

  const requireFolder = Effect.fn("ThreadFolderService.requireFolder")(function* (
    folderId: ThreadFolderId,
  ) {
    const rows = yield* sql<{ readonly folder_id: string }>`
      SELECT folder_id FROM thread_folders WHERE folder_id = ${folderId}
    `;
    if (rows.length === 0) {
      return yield* folderError(`Folder ${folderId} does not exist.`, { folderId });
    }
  });

  const placeThreads = (
    threadIds: ReadonlyArray<ThreadId>,
    folderId: ThreadFolderId | null,
    now: string,
  ) =>
    Effect.forEach(
      new Set(threadIds),
      (threadId) =>
        folderId === null
          ? sql`DELETE FROM thread_folder_members WHERE thread_id = ${threadId}`
          : sql`
              INSERT INTO thread_folder_members (thread_id, folder_id, added_at)
              VALUES (${threadId}, ${folderId}, ${now})
              ON CONFLICT (thread_id) DO UPDATE SET
                folder_id = excluded.folder_id,
                added_at = excluded.added_at
              WHERE thread_folder_members.folder_id <> excluded.folder_id
            `,
      { discard: true },
    );

  const apply = Effect.fn("ThreadFolderService.apply")(function* (
    mutation: ThreadFolderMutation,
    now: string,
  ) {
    switch (mutation.type) {
      case "folder.create": {
        const existing = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM thread_folders
        `;
        if ((existing[0]?.count ?? 0) >= MAX_THREAD_FOLDERS) {
          return yield* folderError(
            `An environment can have at most ${MAX_THREAD_FOLDERS} folders.`,
          );
        }
        yield* requireLiveThreads(mutation.threadIds ?? []);
        // Retrying a create with the same id is a no-op, so client retries are safe.
        const created = yield* sql`
          INSERT INTO thread_folders (folder_id, name, icon_json, created_at, updated_at)
          VALUES (
            ${mutation.folderId},
            ${mutation.name},
            ${mutation.icon == null ? null : encodeIcon(mutation.icon)},
            ${now},
            ${now}
          )
          ON CONFLICT (folder_id) DO NOTHING
          RETURNING folder_id
        `;
        if (created.length === 0) return;
        return yield* placeThreads(mutation.threadIds ?? [], mutation.folderId, now);
      }
      case "folder.update": {
        yield* requireFolder(mutation.folderId);
        if (mutation.name !== undefined) {
          yield* sql`
            UPDATE thread_folders SET name = ${mutation.name}, updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
        }
        if (mutation.icon !== undefined) {
          yield* sql`
            UPDATE thread_folders
            SET icon_json = ${mutation.icon === null ? null : encodeIcon(mutation.icon)},
              updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
        }
        return;
      }
      case "folder.delete":
        // Members cascade, so the threads simply leave the folder.
        yield* sql`DELETE FROM thread_folders WHERE folder_id = ${mutation.folderId}`;
        return;
      case "folder.move":
        if (mutation.folderId !== null) yield* requireFolder(mutation.folderId);
        yield* requireLiveThreads(mutation.threadIds);
        return yield* placeThreads(mutation.threadIds, mutation.folderId, now);
    }
  });

  const mutate: ThreadFolderService["Service"]["mutate"] = Effect.fn("ThreadFolderService.mutate")(
    function* (mutation) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* writes.withPermit(
        sql.withTransaction(apply(mutation, now)).pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(folderError("Could not save the thread folder.", { cause })),
          }),
        ),
      );
      yield* PubSub.publish(changes, undefined);
      return yield* list();
    },
  );

  return ThreadFolderService.of({ list, subscribeList, mutate });
});

export const layer = Layer.effect(ThreadFolderService, make);
