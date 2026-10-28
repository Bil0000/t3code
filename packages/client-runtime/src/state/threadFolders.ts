import type { EnvironmentId, ThreadFolder, ThreadId } from "@t3tools/contracts";

export interface EnvironmentThreadFolder extends ThreadFolder {
  readonly environmentId: EnvironmentId;
}

export function scopedThreadFolderKey(folder: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}): string {
  return `${folder.environmentId}:${folder.id}`;
}

export interface ThreadFolderBlock<T> {
  readonly folder: EnvironmentThreadFolder;
  readonly key: string;
  readonly threads: ReadonlyArray<T>;
}

/**
 * Splits `threads` into folder blocks, in folder order, and the threads no folder holds.
 * A folder keeps its place, so empty folders still render. Thread order inside a block is
 * the order of `threads`, so callers sort once.
 */
export function layoutThreadFolders<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly folders: ReadonlyArray<EnvironmentThreadFolder>;
}): { readonly blocks: ReadonlyArray<ThreadFolderBlock<T>>; readonly unfiled: ReadonlyArray<T> } {
  const folderKeyByThreadKey = new Map<string, string>();
  for (const folder of input.folders) {
    const folderKey = scopedThreadFolderKey(folder);
    for (const threadId of folder.threadIds) {
      folderKeyByThreadKey.set(`${folder.environmentId}:${threadId}`, folderKey);
    }
  }
  const threadsByFolderKey = new Map<string, Array<T>>();
  const unfiled: Array<T> = [];
  for (const thread of input.threads) {
    const folderKey = folderKeyByThreadKey.get(`${thread.environmentId}:${thread.id}`);
    if (folderKey === undefined) {
      unfiled.push(thread);
      continue;
    }
    const list = threadsByFolderKey.get(folderKey) ?? [];
    list.push(thread);
    threadsByFolderKey.set(folderKey, list);
  }
  return {
    blocks: input.folders.map((folder) => {
      const key = scopedThreadFolderKey(folder);
      return { folder, key, threads: threadsByFolderKey.get(key) ?? [] };
    }),
    unfiled,
  };
}

/** The folder that holds a thread, if any. */
export function findThreadFolder(
  folders: ReadonlyArray<EnvironmentThreadFolder>,
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
): EnvironmentThreadFolder | null {
  return (
    folders.find(
      (folder) =>
        folder.environmentId === thread.environmentId && folder.threadIds.includes(thread.id),
    ) ?? null
  );
}
