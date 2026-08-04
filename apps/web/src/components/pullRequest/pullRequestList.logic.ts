import type {
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
} from "@t3tools/contracts";

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
}

/** The signed-in account per host, as the listing reports it. */
export type PullRequestViewers = PullRequestListResult["viewers"];

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Authorship is per host, not per provider kind: the same list can hold change requests from
 * GitHub, GitLab and a GitHub Enterprise install, and the account that owns one says nothing
 * about the others.
 */
function isAuthoredByViewer(entry: PullRequestListEntry, viewers: PullRequestViewers): boolean {
  const viewer = normalize(viewers[entry.host]);
  return viewer !== null && normalize(entry.author?.login) === viewer;
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
 * The server returns the involvement superset for a state, so switching between the Reviewing
 * and Authored tabs never waits on the network.
 */
export function filterPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<PullRequestListEntry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  }
  return entries;
}

/**
 * Only relationships the list data actually carries: no "previously reviewed" bucket is
 * inferred, because the listing has no review history.
 */
export function groupPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup> {
  const buckets: Record<PullRequestGroupKey, PullRequestListEntry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) {
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

/** Repository plus number is unique on one host, so the host makes the key unique overall. */
export function pullRequestEntryKey(entry: PullRequestListEntry): string {
  return `${entry.host}:${entry.repository}#${entry.number}`;
}

/**
 * The project scope to actually ask for. A `projectId` in the URL outlives the environment it
 * came from, and one from elsewhere narrows the listing to nothing — an empty page with no
 * visible filter explaining it, since the switcher has no such project to show as selected. So
 * an id the environment does not have is dropped.
 *
 * Until the projects are known, the id is kept rather than dropped: an environment that has not
 * reported yet is not the same as one without the project, and dropping first would show every
 * project's pull requests for a moment before narrowing back down.
 */
export function resolveProjectScope<Id extends string>(
  projectId: Id | undefined,
  projects: ReadonlyArray<{ readonly id: string }>,
): Id | undefined {
  if (projectId === undefined || projects.length === 0) return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : undefined;
}
