import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { makeWorktreeAutoDelete } from "./WorktreeAutoDelete.ts";

const projectId = ProjectId.make("worktree-cleanup-project");
const branch = "feature/worktree-cleanup";
const old = "2026-01-01T00:00:00.000Z";
const recent = "2099-01-01T00:00:00.000Z";

const makeThread = (
  id: string,
  worktreePath: string,
  overrides: Partial<ProjectionThread> = {},
): ProjectionThread => ({
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch,
  worktreePath,
  latestTurnId: null,
  createdAt: old,
  updatedAt: old,
  archivedAt: null,
  settledOverride: "settled",
  settledAt: old,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
  ...overrides,
});

describe("worktree auto-delete", () => {
  it.effect("only removes eligible clean managed worktrees and preserves interrupts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let projects: ProjectionProject[] = [];
        let threads: ProjectionThread[] = [];
        const removed: Array<{ path: string; force: boolean | undefined }> = [];
        const dirtyPaths = new Set<string>();
        const activeThreadIds = new Set<ThreadId>();
        const terminalPaths = new Set<string>();
        let racePath = "";
        let interruptPath = "";

        const testLayer = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-cleanup-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          ServerSettingsService.layerTest(),
          Layer.mock(ProjectionProjectRepository)({
            listAll: () => Effect.succeed(projects),
          }),
          Layer.mock(ProjectionThreadRepository)({
            listByProjectId: () => Effect.succeed(threads),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (threadId) => {
              const thread = threads.find(
                (candidate) => candidate.threadId === threadId && candidate.deletedAt === null,
              );
              if (!thread) return Effect.succeed(Option.none<OrchestrationThreadShell>());
              return Effect.succeed(
                Option.some({
                  id: thread.threadId,
                  worktreePath: thread.worktreePath,
                  branch: thread.branch,
                  settledOverride: thread.settledOverride,
                  settledAt: thread.settledAt,
                  latestUserMessageAt: thread.latestUserMessageAt,
                  latestTurn: null,
                  session: null,
                  hasPendingApprovals: thread.pendingApprovalCount > 0,
                  hasPendingUserInput: thread.pendingUserInputCount > 0,
                  backgroundLiveness: null,
                } as unknown as OrchestrationThreadShell),
              );
            },
          }),
          Layer.mock(ProviderService)({
            listSessions: () =>
              Effect.succeed(
                [...activeThreadIds].map((threadId) => ({ threadId }) as ProviderSession),
              ),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            subscribeMetadata: (listener) =>
              listener({
                type: "snapshot",
                terminals: [...terminalPaths].map((cwd, index) => ({
                  threadId: `other-${index}`,
                  terminalId: `terminal-${index}`,
                  cwd,
                  worktreePath: null,
                  status: "running" as const,
                  pid: 1,
                  exitCode: null,
                  exitSignal: null,
                  hasRunningSubprocess: false,
                  label: "shell",
                  updatedAt: old,
                })),
              }).pipe(Effect.as(() => undefined)),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            statusDetailsLocal: (cwd) => {
              if (cwd === interruptPath) return Effect.interrupt;
              return Effect.sync(() => {
                if (cwd === racePath) {
                  threads = threads.map((thread) =>
                    thread.worktreePath === racePath
                      ? { ...thread, settledOverride: "active", settledAt: null }
                      : thread,
                  );
                }
                return {
                  isRepo: true,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch,
                  upstreamRef: null,
                  hasWorkingTreeChanges: dirtyPaths.has(cwd),
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                };
              });
            },
            removeWorktree: (input) =>
              Effect.sync(() => removed.push({ path: input.path, force: input.force })),
          }),
          Layer.mock(CheckpointReactor)({ drain: Effect.void }),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drainThrough: () => Effect.void,
          }),
          Layer.mock(OrchestrationEngineService)({
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
          NodeServices.layer,
        );

        yield* Effect.gen(function* () {
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const deletedPath = path.join(config.worktreesDir, "repo", "deleted");
          const expiredPath = path.join(config.worktreesDir, "repo", "expired");
          const recentPath = path.join(config.worktreesDir, "repo", "recent");
          const sharedPath = path.join(config.worktreesDir, "repo", "shared");
          const dirtyPath = path.join(config.worktreesDir, "repo", "dirty");
          const sessionPath = path.join(config.worktreesDir, "repo", "session");
          const terminalPath = path.join(config.worktreesDir, "repo", "terminal");
          racePath = path.join(config.worktreesDir, "repo", "race");
          interruptPath = path.join(config.worktreesDir, "repo", "interrupt");
          const outsidePath = yield* fs.makeTempDirectoryScoped({ prefix: "outside-worktree-" });
          const managedPaths = [
            interruptPath,
            deletedPath,
            expiredPath,
            recentPath,
            sharedPath,
            dirtyPath,
            sessionPath,
            terminalPath,
            racePath,
          ];
          yield* Effect.forEach(managedPaths, (candidate) =>
            fs.makeDirectory(candidate, { recursive: true }),
          );
          const terminalChildPath = path.join(terminalPath, "packages", "app");
          yield* fs.makeDirectory(terminalChildPath, { recursive: true });

          projects = [
            {
              projectId,
              title: "Project",
              workspaceRoot: process.cwd(),
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              scripts: [],
              createdAt: old,
              updatedAt: old,
              deletedAt: null,
            },
          ];
          threads = [
            makeThread("interrupt", interruptPath, { settledAt: recent }),
            makeThread("deleted", deletedPath, {
              settledOverride: null,
              settledAt: null,
              deletedAt: old,
            }),
            makeThread("expired", expiredPath),
            makeThread("recent", recentPath, { settledAt: recent }),
            makeThread("shared-settled", sharedPath),
            makeThread("shared-active", sharedPath, {
              settledOverride: null,
              settledAt: null,
            }),
            makeThread("dirty", dirtyPath),
            makeThread("outside", outsidePath),
            makeThread("session", sessionPath),
            makeThread("terminal", terminalPath),
            makeThread("race", racePath),
          ];
          dirtyPaths.add(dirtyPath);
          activeThreadIds.add(ThreadId.make("session"));
          terminalPaths.add(terminalChildPath);

          yield* TestClock.setTime(Date.parse("2026-08-30T00:00:00.000Z"));
          const cleanup = yield* makeWorktreeAutoDelete;
          const settings = yield* ServerSettingsService;

          yield* cleanup.sweep;
          assert.isEmpty(removed);

          yield* settings.updateSettings({ worktreeAutoDeleteAfterDays: 3 });
          yield* cleanup.sweep;

          assert.deepStrictEqual(
            removed.map(({ path: removedPath }) => removedPath).sort(),
            [deletedPath, expiredPath].sort(),
          );
          assert.isTrue(removed.every(({ force }) => force !== true));

          threads = threads.map((thread) =>
            thread.threadId === ThreadId.make("interrupt") ? { ...thread, settledAt: old } : thread,
          );
          const exit = yield* Effect.exit(cleanup.sweep);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );
});
