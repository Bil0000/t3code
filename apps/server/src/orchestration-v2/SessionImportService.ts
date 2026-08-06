import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  OrchestrationV2ImportSessionError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ImportSessionInput,
  type OrchestrationV2ImportSessionResult,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ResolveImportSessionInput,
  type OrchestrationV2ResolveImportSessionResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeOS from "node:os";

import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  SESSION_IMPORT_EVENT_PREFIX,
  buildImportedThreadEvents,
  importedEntryEventId,
  isImportableSessionDriver,
  mapClaudeSessionMessages,
  parseCodexRollout,
  type ImportableSessionDriver,
  type ImportedTranscriptEntry,
} from "./SessionImportTranscript.ts";

const IMPORTED_THREAD_TITLE_MAX_CHARS = 120;

interface SessionImportRow {
  readonly thread_id: string;
  readonly driver: string;
  readonly provider_instance_id: string;
  readonly external_id: string;
  readonly source_modified_at: string | null;
}

export interface SessionImportServiceShape {
  readonly resolveImportSession: (
    input: OrchestrationV2ResolveImportSessionInput,
  ) => Effect.Effect<OrchestrationV2ResolveImportSessionResult, OrchestrationV2ImportSessionError>;
  readonly importSession: (
    input: OrchestrationV2ImportSessionInput,
  ) => Effect.Effect<OrchestrationV2ImportSessionResult, OrchestrationV2ImportSessionError>;
  /**
   * Re-reads the provider's on-disk transcript behind an imported thread and
   * appends any conversation that happened outside T3 since the last sync.
   * No-op for threads that were not created by an import. Never fails the
   * caller: sync problems are logged and surfaced via the imports table.
   */
  readonly ensureSynced: (threadId: ThreadId) => Effect.Effect<void>;
}

export class SessionImportService extends Context.Service<
  SessionImportService,
  SessionImportServiceShape
>()("t3/orchestration-v2/SessionImportService") {}

const importError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new OrchestrationV2ImportSessionError({ message })
    : new OrchestrationV2ImportSessionError({ message, cause });

const claudeSessionNotFound = (externalId: string) =>
  importError(
    `No Claude Code session '${externalId}' exists on this machine. Run /status inside the session to copy its id, or pick it from "claude --resume".`,
  );

const codexSessionNotFound = (externalId: string) =>
  importError(
    `No Codex thread '${externalId}' exists on this machine. Run "codex resume" to list thread ids.`,
  );

const readClaudeSessionInfo = (externalId: string) =>
  Effect.tryPromise({
    try: () => getSessionInfo(externalId, {}),
    catch: (cause) => importError(`Could not read Claude Code session '${externalId}'.`, cause),
  });

const readClaudeTranscript = (externalId: string) =>
  Effect.tryPromise({
    try: () => getSessionMessages(externalId, {}),
    catch: (cause) =>
      importError(`Could not read the transcript for Claude Code session '${externalId}'.`, cause),
  }).pipe(Effect.map(mapClaudeSessionMessages));

const CODEX_HOME_CONTINUATION_PREFIX = "codex:home:";

/**
 * Locates and reads the rollout transcript for a Codex thread id under
 * `<codex home>/sessions/**`. The home comes from the instance's resolved
 * home layout when available (its continuation key is `codex:home:<path>`),
 * else `$CODEX_HOME`, else `~/.codex`. The sessions directory is shared
 * between the user's own Codex CLI and T3's Codex app-server homes, so a
 * thread started in either is found here.
 */
const makeReadCodexRollout = (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) =>
  Effect.fnUntraced(function* (externalId: string, instanceHome: string | undefined) {
    const { fileSystem, path } = deps;
    const envHome = process.env["CODEX_HOME"]?.trim();
    const home =
      instanceHome ??
      (envHome !== undefined && envHome.length > 0
        ? envHome
        : path.join(NodeOS.homedir(), ".codex"));
    const root = path.join(home, "sessions");
    const names = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const relative = names.find((name) => name.endsWith(`${externalId}.jsonl`));
    if (relative === undefined) {
      return undefined;
    }
    const rolloutPath = path.isAbsolute(relative) ? relative : path.join(root, relative);
    const readFailure = (cause: unknown) =>
      importError(`Could not read the transcript for Codex thread '${externalId}'.`, cause);
    const content = yield* fileSystem
      .readFileString(rolloutPath)
      .pipe(Effect.mapError(readFailure));
    const stat = yield* fileSystem.stat(rolloutPath).pipe(Effect.mapError(readFailure));
    const modifiedAtMs = Option.getOrUndefined(Option.map(stat.mtime, (mtime) => mtime.getTime()));
    return { transcript: parseCodexRollout(content), modifiedAtMs };
  });

function isoOrNull(epochMs: number | undefined): string | null {
  return epochMs === undefined || !Number.isFinite(epochMs)
    ? null
    : DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function importedThreadTitle(input: {
  readonly externalId: string;
  readonly title: string | undefined;
}): string {
  const title = input.title?.trim() ?? "";
  return title.length > 0
    ? title.slice(0, IMPORTED_THREAD_TITLE_MAX_CHARS)
    : `Imported session ${input.externalId.slice(0, 8)}`;
}

function codexTitleFromEntries(
  entries: ReadonlyArray<ImportedTranscriptEntry>,
): string | undefined {
  const first = entries.find((entry) => entry.kind === "message" && entry.role === "user");
  return first?.kind === "message"
    ? first.text.slice(0, IMPORTED_THREAD_TITLE_MAX_CHARS)
    : undefined;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSinkV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const projectionStore = yield* ProjectionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const readCodexRollout = makeReadCodexRollout({
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
  });
  const syncExecutor = yield* makeKeyedSerialExecutor<ThreadId>();
  /** Threads confirmed to have no import row; skipped without a query. */
  const nonImportedThreadIds = new Set<ThreadId>();

  /**
   * Home directory of a codex instance, read from its resolved home layout
   * (the continuation key is `codex:home:<shared home path>`). Undefined for
   * registries that do not expose metadata (tests) or non-codex drivers.
   */
  const codexInstanceHome = (instanceId: ProviderInstanceId) =>
    adapters.getMetadata === undefined
      ? Effect.succeed<string | undefined>(undefined)
      : adapters.getMetadata(instanceId).pipe(
          Effect.map((metadata) =>
            metadata.continuationKey.startsWith(CODEX_HOME_CONTINUATION_PREFIX)
              ? metadata.continuationKey.slice(CODEX_HOME_CONTINUATION_PREFIX.length)
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        );

  const requireImportableDriver = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ImportableSessionDriver, OrchestrationV2ImportSessionError> {
    const adapter = yield* adapters
      .get(instanceId)
      .pipe(
        Effect.mapError((cause) =>
          importError(`Provider instance '${instanceId}' is not available.`, cause),
        ),
      );
    if (isImportableSessionDriver(adapter.driver)) {
      return adapter.driver;
    }
    return yield* importError(
      `Importing an existing session is only supported for Claude Code and Codex, not '${adapter.driver}'.`,
    );
  });

  const lookupProjectIdByWorkspaceRoot = (workspaceRoot: string) =>
    sql<{ readonly project_id: string }>`
      SELECT project_id
      FROM projection_projects
      WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : ProjectId.make(rows[0].project_id))),
      Effect.mapError((cause) =>
        importError(`Could not look up a project for '${workspaceRoot}'.`, cause),
      ),
    );

  const resolveImportSession: SessionImportServiceShape["resolveImportSession"] = Effect.fnUntraced(
    function* (input) {
      const driver = yield* requireImportableDriver(input.instanceId);
      if (driver === "claudeAgent") {
        const sessionInfo = yield* readClaudeSessionInfo(input.externalId);
        if (sessionInfo === undefined) {
          return yield* claudeSessionNotFound(input.externalId);
        }
        const title = sessionInfo.summary.trim();
        const workspaceRoot = sessionInfo.cwd?.trim() ?? "";
        return {
          externalId: input.externalId,
          workspaceRoot: workspaceRoot.length > 0 ? workspaceRoot : null,
          projectId:
            workspaceRoot.length > 0 ? yield* lookupProjectIdByWorkspaceRoot(workspaceRoot) : null,
          title: title.length > 0 ? title : null,
        };
      }
      const rollout = yield* readCodexRollout(
        input.externalId,
        yield* codexInstanceHome(input.instanceId),
      );
      if (rollout === undefined) {
        return yield* codexSessionNotFound(input.externalId);
      }
      const workspaceRoot = rollout.transcript.workspaceRoot;
      const title = codexTitleFromEntries(rollout.transcript.entries) ?? null;
      return {
        externalId: input.externalId,
        workspaceRoot,
        projectId:
          workspaceRoot === null ? null : yield* lookupProjectIdByWorkspaceRoot(workspaceRoot),
        title,
      };
    },
  );

  const insertPositions = (
    threadId: ThreadId,
    positions: ReadonlyArray<{ readonly turnItemId: string; readonly ordinal: number }>,
  ) =>
    Effect.forEach(
      positions,
      (position) =>
        sql`
          INSERT INTO orchestration_v2_turn_item_positions (
            thread_id,
            turn_item_id,
            ordinal
          )
          VALUES (${threadId}, ${position.turnItemId}, ${position.ordinal})
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `,
      { discard: true },
    );

  interface SourceTranscript {
    readonly entries: ReadonlyArray<ImportedTranscriptEntry>;
    readonly workspaceRoot: string | null;
    readonly title: string | undefined;
    readonly sourceModifiedAt: string | null;
  }

  const readSourceTranscript = Effect.fnUntraced(function* (
    driver: ImportableSessionDriver,
    externalId: string,
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<SourceTranscript | undefined, OrchestrationV2ImportSessionError> {
    if (driver === "claudeAgent") {
      const sessionInfo = yield* readClaudeSessionInfo(externalId);
      if (sessionInfo === undefined) {
        return undefined;
      }
      const entries = yield* readClaudeTranscript(externalId);
      return {
        entries,
        workspaceRoot: sessionInfo.cwd?.trim() || null,
        title: sessionInfo.summary,
        sourceModifiedAt: isoOrNull(sessionInfo.lastModified),
      };
    }
    const rollout = yield* readCodexRollout(externalId, yield* codexInstanceHome(instanceId));
    if (rollout === undefined) {
      return undefined;
    }
    return {
      entries: rollout.transcript.entries,
      workspaceRoot: rollout.transcript.workspaceRoot,
      title: codexTitleFromEntries(rollout.transcript.entries),
      sourceModifiedAt: isoOrNull(rollout.modifiedAtMs),
    };
  });

  const importSession: SessionImportServiceShape["importSession"] = Effect.fnUntraced(
    function* (input) {
      const projectRows = yield* sql<{ readonly workspace_root: string }>`
      SELECT workspace_root
      FROM projection_projects
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(
        Effect.mapError((cause) =>
          importError(`Could not read project '${input.projectId}'.`, cause),
        ),
      );
      const project = projectRows[0];
      if (project === undefined) {
        return yield* importError(`Project '${input.projectId}' no longer exists.`);
      }
      const driver = yield* requireImportableDriver(input.modelSelection.instanceId);

      const existingImports = yield* sql<SessionImportRow>`
      SELECT thread_id, driver, provider_instance_id, external_id, source_modified_at
      FROM orchestration_v2_session_imports
      WHERE driver = ${driver} AND external_id = ${input.externalId}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => importError("Could not check existing imports.", cause)));
      if (existingImports[0] !== undefined) {
        return yield* importError(
          `Session '${input.externalId}' is already imported as a thread. Open that thread instead of importing it again.`,
        );
      }

      const providerThreadId = ids.derive.providerThread({
        driver: providerDriverKindOf(driver),
        nativeThreadId: input.externalId,
      });
      const boundProviderThreads = yield* sql<{ readonly provider_thread_id: string }>`
      SELECT provider_thread_id
      FROM orchestration_v2_projection_provider_threads
      WHERE provider_thread_id = ${providerThreadId}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => importError("Could not check existing imports.", cause)));
      if (boundProviderThreads[0] !== undefined) {
        return yield* importError(
          `Session '${input.externalId}' already belongs to a thread in this workspace.`,
        );
      }

      const source = yield* readSourceTranscript(
        driver,
        input.externalId,
        input.modelSelection.instanceId,
      );
      if (source === undefined) {
        return yield* driver === "claudeAgent"
          ? claudeSessionNotFound(input.externalId)
          : codexSessionNotFound(input.externalId);
      }
      if (source.workspaceRoot !== null && source.workspaceRoot !== project.workspace_root) {
        return yield* importError(
          `Session '${input.externalId}' ran in ${source.workspaceRoot}, not in ${project.workspace_root}. Import it from a thread in that project.`,
        );
      }
      const messageCount = source.entries.filter((entry) => entry.kind === "message").length;
      if (messageCount === 0) {
        return yield* importError(`Session '${input.externalId}' has no conversation to import.`);
      }

      const now = yield* DateTime.now;
      const threadId = ThreadId.make(
        `thread:${SESSION_IMPORT_EVENT_PREFIX}:${driver}:${input.externalId}`,
      );
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "server",
        id: threadId,
        projectId: input.projectId,
        title: importedThreadTitle({ externalId: input.externalId, title: source.title }),
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        historyOrigin: "provider_import",
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const providerDriver = providerDriverKindOf(driver);
      const batch = buildImportedThreadEvents({
        driver,
        providerDriver,
        threadId,
        entries: source.entries.map((entry, index) => ({ entry, index })),
        fallbackAt: now,
      });
      const lastMessageEntry = source.entries.findLast((entry) => entry.kind === "message");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: providerDriver,
        providerInstanceId: input.modelSelection.instanceId,
        providerSessionId: ids.derive.providerSession({
          providerInstanceId: input.modelSelection.instanceId,
        }),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: providerDriver,
          nativeId: input.externalId,
          strength: "strong",
        },
        // Claude decides "resume vs fresh session id" per turn from this head
        // ref; without it the first turn opens with `sessionId: <external id>`
        // and the CLI rejects the id as already in use.
        nativeConversationHeadRef:
          driver === "claudeAgent" && lastMessageEntry !== undefined
            ? { driver: providerDriver, nativeId: lastMessageEntry.sourceId, strength: "weak" }
            : null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: thread,
        },
        ...batch.events,
        {
          id: EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerDriver,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: providerThread,
        },
      ];

      yield* insertPositions(threadId, batch.positions).pipe(
        Effect.mapError((cause) => importError("Could not store the imported transcript.", cause)),
      );
      yield* eventSink
        .write({ events })
        .pipe(
          Effect.mapError((cause) =>
            importError("Could not store the imported transcript.", cause),
          ),
        );
      const syncedAt = DateTime.formatIso(now);
      yield* sql`
      INSERT INTO orchestration_v2_session_imports (
        thread_id,
        driver,
        provider_instance_id,
        external_id,
        source_modified_at,
        last_synced_at,
        imported_message_count,
        last_error
      )
      VALUES (
        ${threadId},
        ${driver},
        ${input.modelSelection.instanceId},
        ${input.externalId},
        ${source.sourceModifiedAt},
        ${syncedAt},
        ${messageCount},
        NULL
      )
      ON CONFLICT(thread_id) DO NOTHING
    `.pipe(
        Effect.mapError((cause) => importError("Could not record the imported session.", cause)),
      );
      return { threadId };
    },
  );

  const syncImportedTranscript = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql<SessionImportRow>`
      SELECT thread_id, driver, provider_instance_id, external_id, source_modified_at
      FROM orchestration_v2_session_imports
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      nonImportedThreadIds.add(threadId);
      return;
    }
    const driver = row.driver;
    if (!isImportableSessionDriver(driver)) {
      return;
    }
    const projection = yield* projectionStore.getThreadProjection(threadId);
    // Never interleave a sync with a live provider turn: the transcript is
    // mid-write and the projection is about to receive the same content as
    // native run items.
    const hasActiveRun = projection.runs.some(
      (run) =>
        run.status === "preparing" ||
        run.status === "queued" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    );
    if (hasActiveRun) {
      return;
    }
    const source = yield* readSourceTranscript(
      driver,
      row.external_id,
      ProviderInstanceId.make(row.provider_instance_id),
    );
    if (source === undefined || source.entries.length === 0) {
      return;
    }
    if (source.sourceModifiedAt !== null && source.sourceModifiedAt === row.source_modified_at) {
      return;
    }

    const knownNativeIds = new Set<string>();
    for (const item of projection.turnItems) {
      const nativeId = item.nativeItemRef?.nativeId;
      if (nativeId !== null && nativeId !== undefined) {
        knownNativeIds.add(nativeId);
      }
    }
    const knownRunMessages = new Set(
      projection.messages
        .filter((message) => message.runId !== null)
        .map((message) => `${message.role}\n${message.text.trim()}`),
    );
    const existingEventRows = yield* sql<{ readonly event_id: string }>`
      SELECT event_id
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_id LIKE ${`${SESSION_IMPORT_EVENT_PREFIX}:%`}
    `;
    const existingEventIds = new Set(existingEventRows.map((existing) => existing.event_id));

    const missing = source.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => {
        if (existingEventIds.has(importedEntryEventId({ driver, threadId, index, entry }))) {
          return false;
        }
        // Turns T3 itself drove are already in the thread as native run
        // items; the provider transcript echoes them back. Match by native
        // id first, then by exact role+text as a backstop for entries whose
        // native ids the adapter did not record.
        if (knownNativeIds.has(entry.sourceId)) return false;
        if (
          entry.kind === "message" &&
          knownRunMessages.has(`${entry.role}\n${entry.text.trim()}`)
        ) {
          return false;
        }
        return true;
      });
    const now = yield* DateTime.now;
    if (missing.length > 0) {
      // New entries happened after everything the thread already shows, so
      // their positions go after the current maximum — including native run
      // bands — instead of into the import's original 0-band.
      const maxOrdinalRows = yield* sql<{ readonly max_ordinal: number | null }>`
        SELECT MAX(ordinal) AS max_ordinal
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId}
      `;
      const batch = buildImportedThreadEvents({
        driver,
        providerDriver: providerDriverKindOf(driver),
        threadId,
        entries: missing,
        fallbackAt: now,
        ordinalBase: maxOrdinalRows[0]?.max_ordinal ?? 0,
      });
      yield* insertPositions(threadId, batch.positions);
      yield* eventSink.write({ events: [...batch.events] });
    }
    yield* sql`
      UPDATE orchestration_v2_session_imports
      SET
        source_modified_at = ${source.sourceModifiedAt},
        last_synced_at = ${DateTime.formatIso(now)},
        imported_message_count = imported_message_count + ${missing.filter(({ entry }) => entry.kind === "message").length},
        last_error = NULL
      WHERE thread_id = ${threadId}
    `;
  });

  const ensureSynced: SessionImportServiceShape["ensureSynced"] = (threadId) =>
    nonImportedThreadIds.has(threadId)
      ? Effect.void
      : syncExecutor.withLock(threadId, syncImportedTranscript(threadId)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to sync imported session transcript", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                sql`
                    UPDATE orchestration_v2_session_imports
                    SET last_error = 'Transcript sync failed; retried on next open.'
                    WHERE thread_id = ${threadId}
                  `.pipe(Effect.ignore),
              ),
            ),
          ),
        );

  return SessionImportService.of({ resolveImportSession, importSession, ensureSynced });
});

function providerDriverKindOf(driver: ImportableSessionDriver): ProviderDriverKind {
  return ProviderDriverKind.make(driver);
}

export const layer: Layer.Layer<
  SessionImportService,
  never,
  | SqlClient.SqlClient
  | EventSinkV2
  | ProviderAdapterRegistryV2
  | ProjectionStoreV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(SessionImportService, make);
