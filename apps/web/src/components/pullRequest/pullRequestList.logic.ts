import type { PullRequestInvolvement, PullRequestListEntry } from "@t3tools/contracts";

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
}

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Free-text filter over the fields a row actually shows, plus `#123` / `123`. */
export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

/**
 * The server returns the involvement superset for a state, so switching between the
 * Reviewing and Authored tabs never waits on the network.
 */
export function filterPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewer: string | null,
  involvement: PullRequestInvolvement,
): ReadonlyArray<PullRequestListEntry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    const normalizedViewer = normalize(viewer);
    return normalizedViewer === null
      ? []
      : entries.filter((entry) => normalize(entry.author?.login) === normalizedViewer);
  }
  return entries;
}

/**
 * Only relationships the list data actually carries: no "previously reviewed" bucket is
 * inferred, because the listing has no review history.
 */
export function groupPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewer: string | null,
): ReadonlyArray<PullRequestGroup> {
  const normalizedViewer = normalize(viewer);
  const buckets: Record<PullRequestGroupKey, PullRequestListEntry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (normalizedViewer !== null && normalize(entry.author?.login) === normalizedViewer) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["reviewRequested", "authored", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

export function pullRequestEntryKey(entry: PullRequestListEntry): string {
  return `${entry.repository}#${entry.number}`;
}
