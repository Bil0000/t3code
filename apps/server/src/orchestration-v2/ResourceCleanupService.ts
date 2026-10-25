import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefPrefixForThread } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { checkpointRefPrefixForScope } from "./CheckpointService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals([
      "terminal",
      "preview",
      "attachment",
      "scheduled-tasks",
      "checkpoint",
    ]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupCheckpointRefs: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupCheckpointRefs: () => Effect.void,
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const crypto = yield* Crypto.Crypto;
    return {
      cleanupCheckpointRefs: Effect.fn("ResourceCleanupService.cleanupCheckpointRefs")(
        function* (threadId: ThreadId) {
          const thread = yield* projections.getThread(threadId);
          if (thread.deletedAt === null) return;
          const { checkpointScopes } = yield* projections.getCheckpointContext(threadId);
          const project = yield* projects.get(thread.projectId, { includeDeleted: true });
          const prefixes = [
            checkpointRefPrefixForThread(threadId),
            ...(yield* Effect.forEach(checkpointScopes, (scope) =>
              checkpointRefPrefixForScope(scope.id).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              ),
            )),
          ];
          const directories = new Set([
            ...checkpointScopes.map((scope) => scope.cwd),
            ...(thread.worktreePath === null ? [] : [thread.worktreePath]),
            ...(Option.isSome(project) ? [project.value.workspaceRoot] : []),
          ]);
          for (const cwd of directories) {
            if (!(yield* fileSystem.exists(cwd)) || !(yield* checkpoints.isGitRepository(cwd))) {
              continue;
            }
            yield* checkpoints.deleteCheckpointRefs({
              cwd,
              checkpointRefs: [],
              checkpointRefPrefixes: prefixes,
            });
          }
        },
        (effect, threadId) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "checkpoint", threadId, cause }),
            ),
          ),
      ),
      cleanupScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
