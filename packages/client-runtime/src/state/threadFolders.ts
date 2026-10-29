import type {
  EnvironmentId,
  ThreadFolder,
  ThreadFolderMutation,
  ThreadFolderRule,
  ThreadId,
} from "@t3tools/contracts";

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

/**
 * Where a folder lands when dropped at `index` among `shown`, the folders of its section in
 * screen order, as the server's `beforeFolderId` over the stored `order`.
 */
export function resolveFolderReorder<Id>(
  order: readonly Id[],
  shown: readonly Id[],
  folderId: Id,
  index: number,
): { readonly beforeFolderId: Id | null } | null {
  const from = shown.indexOf(folderId);
  if (from === -1 || index === from || index === from + 1) return null;
  const before = shown[index];
  if (before !== undefined) return { beforeFolderId: before };
  const rest = order.filter((id) => id !== folderId);
  return { beforeFolderId: rest[rest.indexOf(shown.at(-1)!) + 1] ?? null };
}

/** How a folder collects new threads, in the terms the folder menu offers. */
export type ThreadFolderCollect =
  | { readonly by: "off" }
  | { readonly by: "topic" }
  | { readonly by: "branch" | "worktree"; readonly value: string }
  | { readonly by: "custom" };

export function threadFolderCollect(
  folder: Pick<ThreadFolder, "rule" | "autoFile">,
): ThreadFolderCollect {
  const rule = folder.rule;
  if (rule === null || !folder.autoFile) return { by: "off" };
  if (Object.values(rule).filter((value) => value !== undefined).length === 1) {
    if (rule.smart === true) return { by: "topic" };
    if (rule.branches?.length === 1) return { by: "branch", value: rule.branches[0]! };
    if (rule.worktrees?.length === 1) return { by: "worktree", value: rule.worktrees[0]! };
  }
  return { by: "custom" };
}

/** The `folder.update` that makes a folder collect by `choice`, or null when it already does. */
export function threadFolderCollectUpdate(
  folder: Pick<ThreadFolder, "id" | "rule" | "autoFile">,
  choice: Exclude<ThreadFolderCollect, { readonly by: "custom" }>,
): Extract<ThreadFolderMutation, { readonly type: "folder.update" }> | null {
  if (choice.by === "off") {
    return folder.autoFile ? { type: "folder.update", folderId: folder.id, autoFile: false } : null;
  }
  const rule: ThreadFolderRule =
    choice.by === "topic"
      ? { smart: true }
      : choice.by === "branch"
        ? { branches: [choice.value] }
        : { worktrees: [choice.value] };
  if (folder.autoFile && JSON.stringify(folder.rule) === JSON.stringify(rule)) return null;
  return { type: "folder.update", folderId: folder.id, rule, autoFile: true };
}

/**
 * Branches and worktree names to offer, from the folder's own threads first and then the
 * environment's most recent ones, with the folder's current value always included.
 */
export function threadFolderCollectChoices(
  folder: EnvironmentThreadFolder,
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>,
  limit = 6,
): { readonly branches: ReadonlyArray<string>; readonly worktrees: ReadonlyArray<string> } {
  const members = new Set<string>(folder.threadIds);
  const current = threadFolderCollect(folder);
  // Ranks each value by its best thread: folder members first, then the most recent.
  const rank = (by: "branch" | "worktree") => {
    const best = new Map<string, readonly [member: number, updatedAt: string]>();
    for (const thread of threads) {
      if (thread.environmentId !== folder.environmentId || thread.archivedAt !== null) continue;
      const value =
        by === "branch"
          ? thread.branch
          : (thread.worktreePath
              ?.replace(/[\\/]+$/, "")
              .split(/[\\/]/)
              .at(-1) ?? null);
      if (!value) continue;
      const score = [Number(members.has(thread.id)), thread.updatedAt] as const;
      const previous = best.get(value);
      if (
        !previous ||
        score[0] > previous[0] ||
        (score[0] === previous[0] && score[1] > previous[1])
      )
        best.set(value, score);
    }
    const ordered = [...best]
      .sort(([, a], [, b]) => b[0] - a[0] || b[1].localeCompare(a[1]))
      .map(([value]) => value);
    const pinned = current.by === by ? [current.value] : [];
    return [...new Set([...pinned, ...ordered])].slice(0, limit);
  };
  return { branches: rank("branch"), worktrees: rank("worktree") };
}
