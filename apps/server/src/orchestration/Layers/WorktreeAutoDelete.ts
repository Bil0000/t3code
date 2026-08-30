import type {
  OrchestrationEvent,
  TerminalSummary,
  WorktreeAutoDeleteAfterDays,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { forkParked } from "../../serverActivation.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

type WorktreeReference = {
  readonly thread: ProjectionThread;
  readonly workspaceRoot: string;
};

type WorktreeCandidate = {
  readonly path: string;
  readonly branch: string;
  readonly references: ReadonlyArray<WorktreeReference>;
};

const parsedMillis = (value: string): number | null => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
};

const threadIsReady = (
  thread: ProjectionThread,
  delay: WorktreeAutoDeleteAfterDays,
  nowMs: number,
): boolean => {
  if (thread.deletedAt !== null) return true;
  if (thread.settledOverride !== "settled" || thread.settledAt === null) return false;
  const settledAt = parsedMillis(thread.settledAt);
  if (settledAt === null || settledAt + delay * DAY_MS > nowMs) return false;
  if (thread.latestUserMessageAt === null) return true;
  const latestUserMessageAt = parsedMillis(thread.latestUserMessageAt);
  return latestUserMessageAt !== null && latestUserMessageAt <= settledAt;
};

export const makeWorktreeAutoDelete = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const checkpointReactor = yield* CheckpointReactor;
  const deletionReactor = yield* ThreadDeletionReactor;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const loadGroups = Effect.fn("WorktreeAutoDelete.loadGroups")(function* (
    delay: WorktreeAutoDeleteAfterDays,
  ) {
    const root = yield* fileSystem.realPath(path.resolve(config.worktreesDir)).pipe(Effect.option);
    if (Option.isNone(root)) return new Map<string, ReadonlyArray<WorktreeReference>>();

    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const groups = new Map<string, WorktreeReference[]>();
    for (const project of yield* projects.listAll()) {
      for (const thread of yield* threads.listByProjectId({ projectId: project.projectId })) {
        if (thread.worktreePath === null) continue;
        const realPath = yield* fileSystem
          .realPath(path.resolve(thread.worktreePath))
          .pipe(Effect.option);
        if (Option.isNone(realPath)) continue;
        if (realPath.value === root.value || !isWithin(root.value, realPath.value)) continue;
        const references = groups.get(realPath.value) ?? [];
        references.push({ thread, workspaceRoot: project.workspaceRoot });
        groups.set(realPath.value, references);
      }
    }

    return new Map(
      [...groups].filter(([, references]) =>
        references.every(({ thread }) => threadIsReady(thread, delay, nowMs)),
      ),
    );
  });

  const toCandidate = (
    candidatePath: string,
    references: ReadonlyArray<WorktreeReference> | undefined,
  ): WorktreeCandidate | null => {
    if (!references?.length) return null;
    const branches = new Set(references.map(({ thread }) => thread.branch));
    if (branches.size !== 1) return null;
    const branch = references[0]?.thread.branch;
    return branch ? { path: candidatePath, branch, references } : null;
  };

  const readTerminals = Effect.fn("WorktreeAutoDelete.readTerminals")(function* () {
    const current = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
    const unsubscribe = yield* terminalManager.subscribeMetadata((event) =>
      event.type === "snapshot" ? Ref.set(current, event.terminals) : Effect.void,
    );
    yield* Effect.sync(unsubscribe);
    return yield* Ref.get(current);
  });

  const runtimeIsIdle = Effect.fn("WorktreeAutoDelete.runtimeIsIdle")(function* (
    candidate: WorktreeCandidate,
  ) {
    const threadIds = new Set(candidate.references.map(({ thread }) => String(thread.threadId)));
    const sessions = yield* providerService.listSessions();
    if (sessions.some((session) => threadIds.has(String(session.threadId)))) return false;

    for (const terminal of yield* readTerminals()) {
      if (threadIds.has(terminal.threadId)) return false;
      for (const terminalPath of [terminal.worktreePath, terminal.cwd]) {
        if (terminalPath === null) continue;
        const realPath = yield* fileSystem.realPath(path.resolve(terminalPath)).pipe(Effect.option);
        if (Option.isSome(realPath) && isWithin(candidate.path, realPath.value)) return false;
      }
    }

    for (const { thread } of candidate.references) {
      if (thread.deletedAt !== null) continue;
      const shell = yield* snapshots.getThreadShellById(thread.threadId);
      if (Option.isNone(shell)) return false;
      const current = shell.value;
      if (
        current.worktreePath === null ||
        path.resolve(current.worktreePath) !== path.resolve(thread.worktreePath ?? "") ||
        current.branch !== candidate.branch ||
        current.settledOverride !== "settled" ||
        current.settledAt !== thread.settledAt ||
        current.hasPendingApprovals ||
        current.hasPendingUserInput ||
        current.backgroundLiveness !== null ||
        current.latestTurn?.state === "running" ||
        (current.session !== null &&
          current.session.status !== "stopped" &&
          current.session.status !== "error")
      ) {
        return false;
      }
    }
    return true;
  });

  const removeCandidate = Effect.fn("WorktreeAutoDelete.removeCandidate")(function* (
    initial: WorktreeCandidate,
    delay: WorktreeAutoDeleteAfterDays,
  ) {
    if (!(yield* runtimeIsIdle(initial))) return;
    const status = yield* git.statusDetailsLocal(initial.path);
    if (!status.isRepo || status.branch !== initial.branch || status.hasWorkingTreeChanges) {
      return;
    }

    const freshGroups = yield* loadGroups(delay);
    const fresh = toCandidate(initial.path, freshGroups.get(initial.path));
    if (fresh === null || !(yield* runtimeIsIdle(fresh))) return;

    yield* git.removeWorktree({
      cwd: fresh.references[0]!.workspaceRoot,
      path: fresh.path,
      force: false,
    });
    yield* Effect.logInfo("worktree.auto-delete.removed", {
      path: fresh.path,
      threadCount: fresh.references.length,
    });
  });

  const sweep = Effect.fn("WorktreeAutoDelete.sweep")(function* () {
    const delay = (yield* serverSettings.getSettings).worktreeAutoDeleteAfterDays;
    if (delay === null) return;
    yield* checkpointReactor.drain;
    const groups = yield* loadGroups(delay);
    for (const [candidatePath, references] of groups) {
      const candidate = toCandidate(candidatePath, references);
      if (candidate === null) continue;
      yield* removeCandidate(candidate, delay).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logDebug("worktree.auto-delete.skipped", {
                path: candidate.path,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  });

  const sweepSafely = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("worktree.auto-delete.sweep-failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const worker = yield* makeDrainableWorker((_: void) => sweepSafely);

  const onDomainEvent = (event: OrchestrationEvent) => {
    if (event.type === "thread.deleted") {
      return deletionReactor
        .drainThrough(event.sequence)
        .pipe(Effect.andThen(worker.enqueue(undefined)));
    }
    if (
      event.type === "thread.settled" ||
      (event.type === "thread.session-set" &&
        (event.payload.session.status === "stopped" || event.payload.session.status === "error"))
    ) {
      return worker.enqueue(undefined);
    }
    return Effect.void;
  };

  const start = Effect.fn("WorktreeAutoDelete.start")(function* () {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, onDomainEvent));
    yield* forkParked(Stream.runForEach(settingsChanges, () => worker.enqueue(undefined)));
    yield* forkParked(worker.enqueue(undefined).pipe(Effect.repeat(Schedule.spaced("1 hour"))));
  });

  return { start, sweep: sweep() };
});

export const WorktreeAutoDeleteLive = Layer.effectDiscard(
  makeWorktreeAutoDelete.pipe(Effect.flatMap(({ start }) => start())),
);
