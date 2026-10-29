import {
  MAX_THREAD_FOLDERS,
  ProjectIconOverride,
  StoredProjectIcon,
  type ThreadFolder,
  ThreadFolderError,
  ThreadFolderRule,
  type ThreadFolderId,
  type ThreadFolderListResult,
  type ThreadFolderMutation,
  type ThreadFolderMutationResult,
  type ThreadFolderSuggestRuleInput,
  type ThreadFolderSuggestRuleResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  pickThreadFolderForRule,
  threadFolderRuleHasConditions,
  threadMatchesFolderRule,
} from "@t3tools/shared/threadFolderRule";
import { visibleThreadPullRequests } from "../sourceControl/threadPullRequests.ts";
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

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class ThreadFolderService extends Context.Service<
  ThreadFolderService,
  {
    readonly autoFile: (threadId: ThreadId) => Effect.Effect<void, ThreadFolderError>;
    readonly list: () => Effect.Effect<ThreadFolderListResult, ThreadFolderError>;
    readonly subscribeList: () => Stream.Stream<ThreadFolderListResult, ThreadFolderError>;
    readonly mutate: (
      mutation: ThreadFolderMutation,
    ) => Effect.Effect<ThreadFolderMutationResult, ThreadFolderError>;
    /** Asks the text generation model for a rule; writes nothing. */
    readonly suggestRule: (
      input: ThreadFolderSuggestRuleInput,
    ) => Effect.Effect<ThreadFolderSuggestRuleResult, ThreadFolderError>;
  }
>()("t3/threadFolders/ThreadFolderService") {}

interface FolderRow {
  readonly folder_id: ThreadFolderId;
  readonly name: string;
  readonly icon_json: string | null;
  readonly rule_json: string | null;
  readonly auto_file: number;
  readonly rule_set_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly thread_id: ThreadId;
  readonly folder_id: ThreadFolderId;
}

const decodeRule = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadFolderRule));
const encodeRule = Schema.encodeSync(Schema.fromJsonString(ThreadFolderRule));

const decodeSuggestedRule = Schema.decodeUnknownOption(ThreadFolderRule);
const decodeSuggestedIcon = Schema.decodeUnknownOption(ProjectIconOverride);
const MAX_RULE_SUGGESTION_SAMPLES = 60;

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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  const writes = yield* Semaphore.make(1);

  const readFolders = Effect.gen(function* () {
    const rows = yield* sql<FolderRow>`
      SELECT folder_id, name, icon_json, rule_json, auto_file, rule_set_at, created_at, updated_at
      FROM thread_folders
      ORDER BY sort_key ASC, created_at ASC, rowid ASC
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
      rule: row.rule_json === null ? null : Option.getOrNull(decodeRule(row.rule_json)),
      autoFile: row.auto_file !== 0,
      ruleSetAt: row.rule_set_at,
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

  const placeThreads = Effect.fn("ThreadFolderService.placeThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    folderId: ThreadFolderId | null,
    now: string,
    explicit = true,
  ) {
    if (explicit) {
      yield* Effect.forEach(
        new Set(threadIds),
        (threadId) =>
          sql`INSERT OR IGNORE INTO thread_folder_explicit_moves (thread_id) VALUES (${threadId})`,
        { discard: true },
      );
    }
    yield* Effect.forEach(
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
  });

  const apply = Effect.fn("ThreadFolderService.apply")(function* (
    mutation: ThreadFolderMutation,
    now: string,
  ) {
    switch (mutation.type) {
      case "folder.create": {
        // Retrying a create with the same id is a no-op, so client retries are safe.
        const replayed = yield* sql`
          SELECT 1 FROM thread_folders WHERE folder_id = ${mutation.folderId}
        `;
        if (replayed.length > 0) return;
        const existing = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM thread_folders
        `;
        if ((existing[0]?.count ?? 0) >= MAX_THREAD_FOLDERS) {
          return yield* folderError(
            `An environment can have at most ${MAX_THREAD_FOLDERS} folders.`,
          );
        }
        const rule = mutation.rule ?? null;
        if (rule !== null && !threadFolderRuleHasConditions(rule)) {
          return yield* folderError("A folder rule needs at least one condition.");
        }
        if (mutation.autoFile === true && rule === null) {
          return yield* folderError("Auto-file needs a folder rule.");
        }
        const positions = yield* sql<{ position: number }>`
          SELECT COALESCE(MIN(sort_key), 0) - 1 AS position FROM thread_folders
        `;
        yield* requireLiveThreads(mutation.threadIds ?? []);
        yield* sql`
          INSERT INTO thread_folders (folder_id, name, icon_json, sort_key, rule_json, auto_file, rule_set_at, created_at, updated_at)
          VALUES (
            ${mutation.folderId},
            ${mutation.name},
            ${mutation.icon == null ? null : encodeIcon(mutation.icon)},
            ${positions[0]!.position},
            ${rule === null ? null : encodeRule(rule)},
            ${Number(mutation.autoFile ?? rule !== null)},
            ${rule === null ? null : now},
            ${now},
            ${now}
          )
        `;
        return yield* placeThreads(mutation.threadIds ?? [], mutation.folderId, now);
      }
      case "folder.update": {
        yield* requireFolder(mutation.folderId);
        const current = (yield* readFolders).find((folder) => folder.id === mutation.folderId)!;
        const rule = mutation.rule === undefined ? current.rule : mutation.rule;
        if (rule !== null && !threadFolderRuleHasConditions(rule)) {
          return yield* folderError("A folder rule needs at least one condition.");
        }
        const autoFile =
          mutation.rule === null
            ? false
            : (mutation.autoFile ??
              (mutation.rule === undefined ? current.autoFile : rule !== null));
        if (autoFile && rule === null) {
          return yield* folderError("Auto-file needs a folder rule.");
        }
        if (mutation.rule !== undefined || mutation.autoFile !== undefined) {
          yield* sql`
            UPDATE thread_folders SET
              rule_json = ${rule === null ? null : encodeRule(rule)},
              auto_file = ${Number(autoFile)},
              rule_set_at = ${mutation.rule === undefined ? current.ruleSetAt : rule === null ? null : now},
              updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
        }
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
      case "folder.reorder": {
        yield* requireFolder(mutation.folderId);
        if (mutation.beforeFolderId !== null) yield* requireFolder(mutation.beforeFolderId);
        if (mutation.folderId === mutation.beforeFolderId) return;
        const folders = yield* readFolders;
        const ids = folders.map((folder) => folder.id).filter((id) => id !== mutation.folderId);
        const index =
          mutation.beforeFolderId === null ? ids.length : ids.indexOf(mutation.beforeFolderId);
        ids.splice(index, 0, mutation.folderId);
        for (const [position, id] of ids.entries()) {
          yield* sql`UPDATE thread_folders SET sort_key = ${position} WHERE folder_id = ${id}`;
        }
        return;
      }
      case "folder.applyRule": {
        yield* requireFolder(mutation.folderId);
        const folders = yield* readFolders;
        const rule = folders.find((folder) => folder.id === mutation.folderId)!.rule;
        if (rule === null) {
          return yield* folderError("This folder has no rule to apply.", {
            folderId: mutation.folderId,
          });
        }
        const filed = new Set(folders.flatMap((folder) => folder.threadIds));
        const snapshot = yield* threads
          .getShellSnapshot({ location: "active" })
          .pipe(Effect.mapError((cause) => folderError("Could not read threads.", { cause })));
        const matching = snapshot.threads.filter(
          (shell) =>
            !filed.has(shell.id) &&
            shell.lineage.relationshipToParent !== "subagent" &&
            threadMatchesFolderRule(rule, {
              ...shell,
              hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
            }),
        );
        return yield* placeThreads(
          matching.map((shell) => shell.id),
          mutation.folderId,
          now,
          false,
        );
      }
      case "folder.delete":
        yield* sql`
          INSERT OR IGNORE INTO thread_folder_explicit_moves (thread_id)
          SELECT thread_id FROM thread_folder_members WHERE folder_id = ${mutation.folderId}
        `;
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

  const autoFile = Effect.fn("ThreadFolderService.autoFile")(function* (threadId: ThreadId) {
    const changed = yield* writes.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const enabled = yield* sql`SELECT 1 FROM thread_folders WHERE auto_file = 1 LIMIT 1`;
            if (enabled.length === 0) return false;
            const shell = yield* threads
              .getThreadShell(threadId)
              .pipe(
                Effect.mapError((cause) =>
                  folderError("Could not read thread for auto-file.", { cause }),
                ),
              );
            if (
              shell === null ||
              shell.deletedAt !== null ||
              shell.archivedAt !== null ||
              shell.lineage.relationshipToParent === "subagent"
            )
              return false;
            const explicit = yield* sql`
              SELECT 1 FROM thread_folder_explicit_moves WHERE thread_id = ${threadId}
            `;
            if (explicit.length > 0) return false;
            const folders = yield* readFolders;
            const subject = {
              ...shell,
              hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
            };
            const createdAt = DateTime.toEpochMillis(shell.createdAt);
            const ruleCovers = (folder: ThreadFolder) =>
              folder.ruleSetAt !== null && createdAt > Date.parse(folder.ruleSetAt);
            const current = folders.find((folder) => folder.threadIds.includes(threadId));
            // An auto-filed thread moves only when the rule that filed it stops matching.
            if (
              current !== undefined &&
              !(
                current.autoFile &&
                current.rule !== null &&
                !threadMatchesFolderRule(current.rule, subject)
              )
            ) {
              return false;
            }
            const folder = pickThreadFolderForRule(folders.filter(ruleCovers), subject);
            if (folder === null && current === undefined) return false;
            yield* placeThreads(
              [threadId],
              folder?.id ?? null,
              DateTime.formatIso(yield* DateTime.now),
              false,
            );
            return true;
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(folderError("Could not auto-file thread.", { cause })),
          }),
        ),
    );
    if (changed) yield* PubSub.publish(changes, undefined);
  });

  const suggestRule = Effect.fn("ThreadFolderService.suggestRule")(function* (
    input: ThreadFolderSuggestRuleInput,
  ) {
    const readError = (cause: unknown) => folderError("Could not read threads.", { cause });
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError(readError));
    const projectShells = yield* projects.listShells().pipe(Effect.mapError(readError));
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => folderError("Could not read settings.", { cause })),
    );
    const projectNames = new Map<string, string>(
      projectShells.map((project) => [project.id, project.title]),
    );
    const samples = snapshot.threads
      .filter((shell) => shell.lineage.relationshipToParent !== "subagent")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )
      .slice(0, MAX_RULE_SUGGESTION_SAMPLES)
      .map((shell) => ({
        title: shell.title,
        branch: shell.branch,
        worktreeName: shell.worktreePath?.split(/[\\/]/).findLast(Boolean) ?? null,
        hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
        projectName: projectNames.get(shell.projectId) ?? null,
      }));
    const generated = yield* textGeneration
      .generateThreadFolderRule({
        cwd: serverConfig.cwd,
        folderName: input.folderName,
        threads: samples,
        projects: projectShells.map((project) => ({ id: project.id, name: project.title })),
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.mapError((cause) =>
          folderError(`Could not suggest a rule: ${cause.detail}`, { cause }),
        ),
      );
    const entries = (values: ReadonlyArray<string>) => {
      const kept = values.map((value) => value.trim()).filter((value) => value.length > 0);
      return kept.length === 0 ? undefined : kept.slice(0, 20);
    };
    const rule = decodeSuggestedRule(
      Object.fromEntries(
        Object.entries({
          projectIds: entries(generated.projectIds.filter((id) => projectNames.has(id))),
          branches: entries(generated.branches),
          worktrees: entries(generated.worktrees),
          titleKeywords: entries(generated.titleKeywords),
          pullRequest: generated.pullRequest,
        }).filter(([, value]) => value != null),
      ),
    );
    if (Option.isNone(rule) || !threadFolderRuleHasConditions(rule.value)) {
      return yield* folderError("Could not suggest a rule for this name.");
    }
    // Only the name's shape is checked here; the client resolves it against its Lucide set.
    const icon =
      generated.icon === null
        ? Option.none()
        : decodeSuggestedIcon({ kind: "lucide", ...generated.icon });
    return { rule: rule.value, icon: Option.getOrNull(icon) };
  });

  return ThreadFolderService.of({ list, subscribeList, mutate, autoFile, suggestRule });
});

export const layer = Layer.effect(ThreadFolderService, make);
