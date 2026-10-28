import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ThreadFolderId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectIconOverride, ReceivedProjectIcon } from "./project.ts";

export const MAX_THREAD_FOLDERS = 200;
export const MAX_THREAD_FOLDER_MOVE_THREADS = 100;

export const ThreadFolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const ThreadFolder = Schema.Struct({
  id: ThreadFolderId,
  name: ThreadFolderName,
  icon: Schema.NullOr(ReceivedProjectIcon),
  // Deleted threads drop out; clients still skip ids they have not loaded.
  threadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadFolder = typeof ThreadFolder.Type;

export const ThreadFolderListInput = Schema.Struct({});
export type ThreadFolderListInput = typeof ThreadFolderListInput.Type;

export const ThreadFolderListResult = Schema.Struct({
  folders: ForwardCompatibleArray(ThreadFolder),
});
export type ThreadFolderListResult = typeof ThreadFolderListResult.Type;

const ThreadFolderMoveThreadIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_THREAD_FOLDER_MOVE_THREADS),
);

export const ThreadFolderMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("folder.create"),
    folderId: ThreadFolderId,
    name: ThreadFolderName,
    icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
    threadIds: Schema.optional(ThreadFolderMoveThreadIds),
  }),
  Schema.Struct({
    type: Schema.Literal("folder.update"),
    folderId: ThreadFolderId,
    name: Schema.optional(ThreadFolderName),
    icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  }),
  Schema.Struct({
    type: Schema.Literal("folder.delete"),
    folderId: ThreadFolderId,
  }),
  Schema.Struct({
    type: Schema.Literal("folder.move"),
    threadIds: ThreadFolderMoveThreadIds,
    // null takes the threads out of their folder.
    folderId: Schema.NullOr(ThreadFolderId),
  }),
]);
export type ThreadFolderMutation = typeof ThreadFolderMutation.Type;

export const ThreadFolderMutationResult = Schema.Struct({
  folders: ForwardCompatibleArray(ThreadFolder),
});
export type ThreadFolderMutationResult = typeof ThreadFolderMutationResult.Type;

export class ThreadFolderError extends Schema.TaggedError<ThreadFolderError>()(
  "ThreadFolderError",
  {
    message: Schema.String,
    folderId: Schema.optional(ThreadFolderId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
