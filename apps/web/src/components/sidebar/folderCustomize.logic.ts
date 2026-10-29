import type {
  ProjectIconOverride,
  ThreadFolder,
  ThreadFolderMutation,
  ThreadFolderRule,
} from "@t3tools/contracts";

export type FolderRuleMode = "name" | "branch" | "worktree";

export interface FolderCustomizeDraft {
  readonly name: string;
  readonly icon: ProjectIconOverride | null;
  readonly rule: ThreadFolderRule | null;
  readonly autoFile: boolean;
}

/** The simple editor state for a rule, or null when the rule needs more than one condition. */
export function folderRuleEditor(
  rule: ThreadFolderRule | null,
): { readonly mode: FolderRuleMode; readonly pattern: string } | null {
  if (rule === null) return { mode: "name", pattern: "" };
  if (Object.values(rule).filter((value) => value !== undefined).length !== 1) return null;
  if (rule.smart === true) return { mode: "name", pattern: "" };
  const [pattern, ...rest] = rule.branches ?? rule.worktrees ?? [];
  if (pattern === undefined || rest.length > 0) return null;
  return { mode: rule.branches ? "branch" : "worktree", pattern };
}

/** A blank pattern is no rule, so an empty rule is never saved. */
export function folderRuleFromEditor(
  mode: FolderRuleMode,
  pattern: string,
): ThreadFolderRule | null {
  if (mode === "name") return { smart: true };
  const value = pattern.trim();
  if (value === "") return null;
  return mode === "branch" ? { branches: [value] } : { worktrees: [value] };
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type FolderUpdate = Extract<ThreadFolderMutation, { type: "folder.update" }>;

/** One `folder.update` carrying only what changed, or null when nothing did. */
export function buildFolderUpdate(
  folder: Pick<ThreadFolder, "id" | "name" | "icon" | "rule" | "autoFile">,
  draft: FolderCustomizeDraft,
): FolderUpdate | null {
  const name = draft.name.trim();
  const ruleChanged = !sameJson(draft.rule, folder.rule);
  const autoFile = draft.rule !== null && draft.autoFile;
  const update: FolderUpdate = {
    type: "folder.update",
    folderId: folder.id,
    ...(name !== "" && name !== folder.name ? { name } : {}),
    ...(!sameJson(draft.icon, folder.icon) ? { icon: draft.icon } : {}),
    ...(ruleChanged ? { rule: draft.rule } : {}),
    // A rule change carries the switch too, so one save sets both.
    ...(ruleChanged || autoFile !== folder.autoFile ? { autoFile } : {}),
  };
  return Object.keys(update).length > 2 ? update : null;
}
