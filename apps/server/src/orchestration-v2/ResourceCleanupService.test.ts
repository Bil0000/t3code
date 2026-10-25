import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { checkpointRefForScopeOrdinal } from "./CheckpointService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const layerVcs = VcsDriverRegistry.layer.pipe(Layer.provideMerge(VcsProcess.layer));
const layerTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "checkpoint-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each([false, true])(
  "cleans deleted-thread refs through the project after its worktree is removed, V2 scopes=%s",
  (hasScope) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const process = yield* VcsProcess.VcsProcess;
      const git = (args: ReadonlyArray<string>) =>
        process.run({ operation: "test.checkpointCleanup", command: "git", cwd, args });
      yield* git(["init"]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      const store = yield* CheckpointStore.CheckpointStore;
      const threadId = ThreadId.make("thread:cleanup");
      const scopeId = CheckpointScopeId.make("scope:cleanup");
      const now = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
      const deletedAt = yield* Ref.make<DateTime.Utc | null>(null);
      const missingWorktree = `${cwd}/removed`;
      const thread = ProjectionStore.emptyProjection({
        id: EventId.make("event:cleanup"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project:cleanup"),
          title: "Cleanup",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: missingWorktree,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: now,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      }).thread;
      const refs = [
        checkpointRefForThreadTurn(threadId, 0),
        checkpointRefForThreadTurn(threadId, 4),
      ];
      if (hasScope) {
        refs.push(
          yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
          yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 19 }),
        );
      }
      const other = checkpointRefForThreadTurn(ThreadId.make("thread:other"), 0);
      for (const ref of [...refs, other]) yield* git(["update-ref", ref, "HEAD"]);
      const cleanupLayer = ResourceCleanupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({}),
            Layer.mock(PreviewManager.PreviewManager)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () =>
                Ref.get(deletedAt).pipe(Effect.map((deletedAt) => ({ ...thread, deletedAt }))),
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [],
                  checkpointScopes: hasScope
                    ? [{ id: scopeId, runId: null, kind: "root_run", cwd: missingWorktree }]
                    : [],
                  checkpoints: [],
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: (_, options) => {
                assert.isTrue(options?.includeDeleted);
                return Effect.succeed(
                  Option.some({
                    projectId: thread.projectId,
                    title: "Cleanup",
                    workspaceRoot: cwd,
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    createdAt: DateTime.formatIso(now),
                    updatedAt: DateTime.formatIso(now),
                    deletedAt: DateTime.formatIso(now),
                  }),
                );
              },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
        yield* cleanup.cleanupCheckpointRefs(threadId);
        assert.isTrue(yield* store.hasCheckpointRef({ cwd, checkpointRef: refs[0]! }));
        yield* Ref.set(deletedAt, now);
        yield* cleanup.cleanupCheckpointRefs(threadId);
        yield* cleanup.cleanupCheckpointRefs(threadId);
        for (const ref of refs)
          assert.isFalse(yield* store.hasCheckpointRef({ cwd, checkpointRef: ref }));
        assert.isTrue(yield* store.hasCheckpointRef({ cwd, checkpointRef: other }));
        assert.equal((yield* git(["rev-parse", "HEAD"])).exitCode, 0);
      }).pipe(Effect.provide(cleanupLayer));
    }).pipe(Effect.provide(layerTest)),
);
