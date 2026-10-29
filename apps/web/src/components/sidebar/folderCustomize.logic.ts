import type {
  ProjectIconOverride,
  ProjectId,
  ProviderInstanceId,
  ThreadFolder,
  ThreadFolderMutation,
  ThreadFolderRule,
} from "@t3tools/contracts";

export const MAX_RULE_ENTRIES = 20;
const MAX_RULE_PATTERN_LENGTH = 200;

export interface FolderRuleDraft {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly branches: ReadonlyArray<string>;
  readonly worktrees: ReadonlyArray<string>;
  readonly titleKeywords: ReadonlyArray<string>;
  readonly pullRequest: boolean | null;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

export interface FolderCustomizeDraft {
  readonly name: string;
  readonly icon: ProjectIconOverride | null;
  readonly rule: FolderRuleDraft;
  readonly autoFile: boolean;
}

export function folderRuleDraft(rule: ThreadFolderRule | null): FolderRuleDraft {
  return {
    projectIds: rule?.projectIds ?? [],
    branches: rule?.branches ?? [],
    worktrees: rule?.worktrees ?? [],
    titleKeywords: rule?.titleKeywords ?? [],
    pullRequest: rule?.pullRequest ?? null,
    providerInstanceIds: rule?.providerInstanceIds ?? [],
  };
}

/** Builds fields in one fixed order, so equal rules serialize equally. */
export function folderRuleFromDraft(draft: FolderRuleDraft): ThreadFolderRule | null {
  const rule: ThreadFolderRule = {
    ...(draft.projectIds.length > 0 ? { projectIds: draft.projectIds } : {}),
    ...(draft.branches.length > 0 ? { branches: draft.branches } : {}),
    ...(draft.worktrees.length > 0 ? { worktrees: draft.worktrees } : {}),
    ...(draft.titleKeywords.length > 0 ? { titleKeywords: draft.titleKeywords } : {}),
    ...(draft.pullRequest !== null ? { pullRequest: draft.pullRequest } : {}),
    ...(draft.providerInstanceIds.length > 0
      ? { providerInstanceIds: draft.providerInstanceIds }
      : {}),
  };
  return Object.keys(rule).length > 0 ? rule : null;
}

/** Adds a trimmed pattern once; returns the list unchanged when it cannot take it. */
export function addRulePattern(list: ReadonlyArray<string>, value: string): ReadonlyArray<string> {
  const pattern = value.trim();
  if (
    pattern === "" ||
    pattern.length > MAX_RULE_PATTERN_LENGTH ||
    list.length >= MAX_RULE_ENTRIES ||
    list.some((entry) => entry.toLowerCase() === pattern.toLowerCase())
  ) {
    return list;
  }
  return [...list, pattern];
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type FolderUpdate = Extract<ThreadFolderMutation, { type: "folder.update" }>;

/** One `folder.update` carrying only what changed, or null when nothing did. */
export function buildFolderUpdate(
  folder: Pick<ThreadFolder, "id" | "name" | "icon" | "rule" | "autoFile">,
  draft: FolderCustomizeDraft,
): FolderUpdate | null {
  const name = draft.name.trim();
  const rule = folderRuleFromDraft(draft.rule);
  const current = folder.rule === null ? null : folderRuleFromDraft(folderRuleDraft(folder.rule));
  const ruleChanged = !sameJson(rule, current);
  const autoFile = rule !== null && draft.autoFile;
  const update: FolderUpdate = {
    type: "folder.update",
    folderId: folder.id,
    ...(name !== "" && name !== folder.name ? { name } : {}),
    ...(!sameJson(draft.icon, folder.icon) ? { icon: draft.icon } : {}),
    ...(ruleChanged ? { rule } : {}),
    // The server re-enables auto-file when a rule changes, so a kept opt-out must be sent.
    ...((ruleChanged && rule !== null) || autoFile !== folder.autoFile ? { autoFile } : {}),
  };
  return Object.keys(update).length > 2 ? update : null;
}
