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

/**
 * How well a row answers the text that was searched for, as a number to order by.
 *
 * Every host searches more than a row shows — GitHub reads bodies and commit messages, GitLab
 * and Bitbucket read descriptions — so a result can be a real match with nothing on the row to
 * show for it. Ordering those by recency alone is what puts an apparently unrelated pull request
 * between two obvious ones. They are still results, so they are still shown; they are shown last,
 * under the rows whose own words matched.
 *
 * The scale is deliberately coarse. It sorts rows into "this is the one", "this mentions it" and
 * "the host says so", which is as fine a judgement as the row's own fields support.
 */
export function scorePullRequestMatch(entry: PullRequestListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  // Asking for a number is asking for one pull request, and it is the answer or it is not.
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  // Every word, in any order: "wizard welcome" is still about the welcome wizard.
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  // The host matched something this row does not show — a description, a comment, a commit.
  return 10;
}

/**
 * Search results in the order they answer the question, most convincing first, and by recency
 * among equals. Only for a search: without one, a listing is a timeline and recency is the order.
 */
export function rankPullRequestMatches(
  entries: ReadonlyArray<PullRequestListEntry>,
  query: string,
): ReadonlyArray<PullRequestListEntry> {
  if (query.trim().length === 0) return entries;
  return entries.toSorted((left, right) => {
    const byScore = scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
    return byScore !== 0 ? byScore : right.updatedAt.localeCompare(left.updatedAt);
  });
}

/**
 * A row with the line counts that arrived after it did. Only where the host left them out — a
 * listing that carried them is not second-guessed — and only where they have arrived, since a row
 * draws perfectly well without them in the meantime.
 */
export function withDiffStat(
  entry: PullRequestListEntry,
  statsByRow: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): PullRequestListEntry {
  if (entry.additions !== 0 || entry.deletions !== 0) return entry;
  const stat = statsByRow.get(`${entry.projectId} ${entry.number}`);
  return stat === undefined ? entry : { ...entry, ...stat };
}
