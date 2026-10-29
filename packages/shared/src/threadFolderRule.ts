import type { ProjectId, ProviderInstanceId, ThreadFolderRule } from "@t3tools/contracts";

export interface ThreadFolderRuleSubject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly hasPullRequest: boolean;
}

// Greedy `*` matching, at most pattern × value steps; a regex of many `.*` backtracks exponentially.
function matchesGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star !== -1) {
      p = star + 1;
      v = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

const matchesAny = (value: string | null, patterns: ReadonlyArray<string>) =>
  value !== null &&
  patterns.some((pattern) => matchesGlob(pattern.toLowerCase(), value.toLowerCase()));

// A keyword must start a word: "review" matches "reviews", never "preview".
const wordStart = (keyword: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");

const lastSegment = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path;

/** True when a rule has at least one condition, so an empty rule never files every thread. */
export function threadFolderRuleHasConditions(rule: ThreadFolderRule): boolean {
  return Object.entries(rule).some(([key, value]) =>
    key === "smart" ? value === true : value !== undefined,
  );
}

export function threadMatchesFolderRule(
  rule: ThreadFolderRule,
  thread: ThreadFolderRuleSubject,
): boolean {
  if (!Object.entries(rule).some(([key, value]) => key !== "smart" && value !== undefined))
    return false;
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
  if (
    rule.titleKeywords &&
    !rule.titleKeywords.some((keyword) => wordStart(keyword).test(thread.title))
  ) {
    return false;
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
        folder.autoFile &&
        folder.rule !== null &&
        !folder.rule.smart &&
        threadMatchesFolderRule(folder.rule, thread),
    ) ?? null
  );
}
