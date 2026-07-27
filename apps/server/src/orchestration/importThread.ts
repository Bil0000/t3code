import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationImportThreadError,
  ThreadId,
  type OrchestrationImportThreadInput,
  type OrchestrationImportThreadResult,
  type OrchestrationResolveImportSessionInput,
  type OrchestrationResolveImportSessionResult,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { mapClaudeSessionMessages, mapCodexThreadSnapshot } from "./importedMessages.ts";
import { mapProviderSessionStatusToOrchestrationStatus } from "./Layers/ProviderCommandReactor.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

const IMPORTED_THREAD_TITLE_MAX_CHARS = 120;

type ImportableDriver = "claudeAgent" | "codex";

function isImportableDriver(driver: string): driver is ImportableDriver {
  return driver === "claudeAgent" || driver === "codex";
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const readClaudeSessionInfo = (externalId: string) =>
  Effect.tryPromise({
    try: () => getSessionInfo(externalId, {}),
    catch: (cause) =>
      new OrchestrationImportThreadError({
        message: `Could not read Claude Code session '${externalId}'.`,
        cause,
      }),
  });

const claudeSessionNotFound = (externalId: string) =>
  new OrchestrationImportThreadError({
    message: `No Claude Code session '${externalId}' exists on this machine. Run /status inside the session to copy its id, or pick it from "claude --resume".`,
  });

function transcriptTimestamp(epochMs: number | undefined): string | undefined {
  return epochMs === undefined || !Number.isFinite(epochMs)
    ? undefined
    : DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function importedThreadTitle(input: {
  readonly externalId: string;
  readonly summary: string | undefined;
}): string {
  const summary = input.summary?.trim() ?? "";
  return summary.length > 0
    ? summary.slice(0, IMPORTED_THREAD_TITLE_MAX_CHARS)
    : `Imported session ${input.externalId.slice(0, 8)}`;
}

export const makeImportThread = (dependencies: {
  readonly crypto: Crypto.Crypto;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getActiveProjectByWorkspaceRoot"
  >;
  readonly providerService: Pick<
    ProviderServiceShape,
    "getInstanceInfo" | "startSession" | "readThread"
  >;
}) => {
  const { crypto, orchestrationEngine, projectionSnapshotQuery, providerService } = dependencies;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`import-thread:${tag}:${uuid}`)),
    );

  const requireImportableDriver = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ImportableDriver, OrchestrationImportThreadError> {
    const instanceInfo = yield* providerService.getInstanceInfo(instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationImportThreadError({
            message: `Provider instance '${instanceId}' is not available.`,
            cause,
          }),
      ),
    );
    const driver = instanceInfo.driverKind;
    if (isImportableDriver(driver)) {
      return driver;
    }
    return yield* new OrchestrationImportThreadError({
      message: `Importing an existing session is only supported for Claude Code and Codex, not '${driver}'.`,
    });
  });

  const readImportedMessages = Effect.fnUntraced(function* (input: {
    readonly driver: ImportableDriver;
    readonly threadId: ThreadId;
    readonly externalId: string;
    readonly workspaceRoot: string;
    readonly transcriptAt: string | undefined;
    readonly importedAt: string;
  }) {
    if (input.driver === "claudeAgent") {
      const sessionMessages = yield* Effect.tryPromise({
        try: () => getSessionMessages(input.externalId, {}),
        catch: (cause) =>
          new OrchestrationImportThreadError({
            message: `Could not read the transcript for Claude Code session '${input.externalId}'.`,
            cause,
          }),
      });
      return mapClaudeSessionMessages({
        threadId: input.threadId,
        importedAt: input.transcriptAt ?? input.importedAt,
        messages: sessionMessages,
      });
    }

    const snapshot = yield* providerService.readThread(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationImportThreadError({
            message: `Could not read the transcript for Codex thread '${input.externalId}'.`,
            cause,
          }),
      ),
    );
    const snapshotWorkspaceRoot = snapshot.workspaceRoot?.trim() ?? "";
    if (snapshotWorkspaceRoot.length > 0 && snapshotWorkspaceRoot !== input.workspaceRoot) {
      return yield* new OrchestrationImportThreadError({
        message: `Codex thread '${input.externalId}' ran in ${snapshotWorkspaceRoot}, not in ${input.workspaceRoot}. Import it from a thread in that project.`,
      });
    }
    return mapCodexThreadSnapshot({
      threadId: input.threadId,
      importedAt: transcriptTimestamp(snapshot.lastActivityAtMs) ?? input.importedAt,
      snapshot,
    });
  });

  const deletingCreatedThreadUnlessImported = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : commandId("delete").pipe(
              Effect.flatMap((deleteCommandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId: deleteCommandId,
                  threadId,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to delete thread after an abandoned import", {
                  threadId,
                  cause,
                }),
              ),
            ),
      ),
    );

  const resolveImportSession = Effect.fnUntraced(function* (
    input: OrchestrationResolveImportSessionInput,
  ): Effect.fn.Return<OrchestrationResolveImportSessionResult, OrchestrationImportThreadError> {
    const driver = yield* requireImportableDriver(input.instanceId);
    if (driver !== "claudeAgent") {
      return { externalId: input.externalId, workspaceRoot: null, projectId: null, title: null };
    }

    const sessionInfo = yield* readClaudeSessionInfo(input.externalId);
    if (sessionInfo === undefined) {
      return yield* claudeSessionNotFound(input.externalId);
    }
    const title = sessionInfo.summary.trim();
    const workspaceRoot = sessionInfo.cwd?.trim() ?? "";
    if (workspaceRoot.length === 0) {
      return {
        externalId: input.externalId,
        workspaceRoot: null,
        projectId: null,
        title: title.length > 0 ? title : null,
      };
    }

    const project = yield* projectionSnapshotQuery
      .getActiveProjectByWorkspaceRoot(workspaceRoot)
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new OrchestrationImportThreadError({
              message: `Could not look up a project for '${workspaceRoot}'.`,
              cause,
            }),
        ),
      );

    return {
      externalId: input.externalId,
      workspaceRoot,
      projectId: project?.id ?? null,
      title: title.length > 0 ? title : null,
    };
  });

  const importThread = Effect.fnUntraced(function* (
    input: OrchestrationImportThreadInput,
  ): Effect.fn.Return<OrchestrationImportThreadResult, OrchestrationImportThreadError> {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(
        (cause) =>
          new OrchestrationImportThreadError({
            message: `Could not read project '${input.projectId}'.`,
            cause,
          }),
      ),
    );
    if (project === undefined) {
      return yield* new OrchestrationImportThreadError({
        message: `Project '${input.projectId}' no longer exists.`,
      });
    }

    const driver = yield* requireImportableDriver(input.modelSelection.instanceId);
    const sessionInfo =
      driver === "claudeAgent" ? yield* readClaudeSessionInfo(input.externalId) : undefined;
    if (driver === "claudeAgent") {
      if (sessionInfo === undefined) {
        return yield* claudeSessionNotFound(input.externalId);
      }
      const sessionWorkspaceRoot = sessionInfo.cwd?.trim() ?? "";
      if (sessionWorkspaceRoot.length > 0 && sessionWorkspaceRoot !== project.workspaceRoot) {
        return yield* new OrchestrationImportThreadError({
          message: `Claude Code session '${input.externalId}' ran in ${sessionWorkspaceRoot}, not in ${project.workspaceRoot}. Import it from a thread in that project.`,
        });
      }
    }

    const createdAt = yield* nowIso;
    const threadId = yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(ThreadId.make));
    yield* orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: yield* commandId("create"),
        threadId,
        projectId: input.projectId,
        title: importedThreadTitle({
          externalId: input.externalId,
          summary: sessionInfo?.summary,
        }),
        modelSelection: input.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationImportThreadError({
              message: "Could not create a thread for the imported session.",
              cause,
            }),
        ),
      );

    yield* deletingCreatedThreadUnlessImported(
      threadId,
      Effect.gen(function* () {
        const session = yield* providerService
          .startSession(threadId, {
            threadId,
            provider: ProviderDriverKind.make(driver),
            providerInstanceId: input.modelSelection.instanceId,
            cwd: project.workspaceRoot,
            modelSelection: input.modelSelection,
            resumeCursor:
              driver === "claudeAgent"
                ? { resume: input.externalId }
                : { threadId: input.externalId },
            runtimeMode: DEFAULT_RUNTIME_MODE,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationImportThreadError({
                  message: `Could not resume session '${input.externalId}' for this thread.`,
                  cause,
                }),
            ),
          );

        const importedAt = yield* nowIso;
        const messages = yield* readImportedMessages({
          driver,
          threadId,
          externalId: input.externalId,
          workspaceRoot: project.workspaceRoot,
          transcriptAt: transcriptTimestamp(sessionInfo?.lastModified),
          importedAt,
        });
        if (messages.length === 0) {
          return yield* new OrchestrationImportThreadError({
            message: `Session '${input.externalId}' has no conversation to import.`,
          });
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.messages.import",
            commandId: yield* commandId("messages"),
            threadId,
            messages,
            createdAt: importedAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationImportThreadError({
                  message: "Could not store the imported transcript.",
                  cause,
                }),
            ),
          );

        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.set",
            commandId: yield* commandId("session"),
            threadId,
            session: {
              threadId,
              status: mapProviderSessionStatusToOrchestrationStatus(session.status),
              providerName: session.provider,
              providerInstanceId: input.modelSelection.instanceId,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: session.lastError ?? null,
              updatedAt: session.updatedAt,
            },
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationImportThreadError({
                  message: "Could not bind the resumed session to this thread.",
                  cause,
                }),
            ),
          );
      }),
    );

    return { threadId };
  });

  return { resolveImportSession, importThread };
};
