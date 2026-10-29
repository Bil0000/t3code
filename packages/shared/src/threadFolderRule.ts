import type { ProjectId, ProviderInstanceId, ThreadFolderRule } from "@t3tools/contracts";

export interface ThreadFolderRuleSubject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly hasPullRequest: boolean;
}

const globPattern = (pattern: string) =>
  new RegExp(
    `^${pattern
      .toLowerCase()
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

const matchesAny = (value: string | null, patterns: ReadonlyArray<string>) =>
  value !== null && patterns.some((pattern) => globPattern(pattern).test(value.toLowerCase()));

const lastSegment = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path;

/** True when a rule has at least one condition, so an empty rule never files every thread. */
export function threadFolderRuleHasConditions(rule: ThreadFolderRule): boolean {
  return Object.values(rule).some((value) => value !== undefined);
}

export function threadMatchesFolderRule(
  rule: ThreadFolderRule,
  thread: ThreadFolderRuleSubject,
): boolean {
  if (!threadFolderRuleHasConditions(rule)) return false;
  if (rule.projectIds && !rule.projectIds.includes(thread.projectId)) return false;
  if (rule.providerInstanceIds && !rule.providerInstanceIds.includes(thread.providerInstanceId)) {
    return false;
  }
  if (rule.pullRequest !== undefined && rule.pullRequest !== thread.hasPullRequest) return false;
  if (rule.branches && !matchesAny(thread.branch, rule.branches)) return false;
  if (
    rule.worktrees &&
    !(
      matchesAny(thread.worktreePath, rule.worktrees) ||
      matchesAny(thread.worktreePath && lastSegment(thread.worktreePath), rule.worktrees)
    )
  ) {
    return false;
  }
  if (rule.titleKeywords) {
    const title = thread.title.toLowerCase();
    if (!rule.titleKeywords.some((keyword) => title.includes(keyword.toLowerCase()))) return false;
  }
  return true;
}

/** The first folder, in folder order, whose enabled rule matches the thread. */
export function pickThreadFolderForRule<
  F extends { readonly rule: ThreadFolderRule | null; readonly autoFile: boolean },
>(folders: ReadonlyArray<F>, thread: ThreadFolderRuleSubject): F | null {
  return (
    folders.find(
      (folder) =>
        folder.autoFile && folder.rule !== null && threadMatchesFolderRule(folder.rule, thread),
    ) ?? null
  );
}
