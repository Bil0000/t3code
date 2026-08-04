/**
 * What the list shows when it has no rows to show.
 *
 * The drawing is the page's own subject rather than a stock empty box: two branch lines and the
 * node where a change would land, in the stroke language the row icons already use. Nothing
 * found leaves the branch unjoined — the gap is the whole picture, so it is drawn once and the
 * variants only decide whether the seam closes.
 */
import { SearchIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * Drawn at the weight of the icons beside it rather than as an illustration with its own
 * palette, so an empty page reads as the same surface with nothing on it.
 */
function BranchMark({ joined }: { joined: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 96 64"
      className="h-16 w-24 text-muted-foreground/40"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* The base line the change would land on, always whole. */}
      <path d="M8 52h80" className="text-muted-foreground/25" stroke="currentColor" />
      <circle cx="8" cy="52" r="4" />
      <circle cx="88" cy="52" r="4" />
      {joined ? (
        // A branch that leaves the base and comes back: the shape of a change that landed.
        <path d="M24 52c0-14 6-20 20-20h8c14 0 20 6 20 20" />
      ) : (
        <>
          {/* The same branch, stopped short. What is missing is the join, so that is what the
              drawing withholds. */}
          <path d="M24 52c0-14 6-20 20-20h4" />
          <path d="M72 52c0-14-6-20-20-20h-4" strokeDasharray="1 6" />
        </>
      )}
      <circle cx="48" cy="32" r="4" className={joined ? undefined : "text-muted-foreground/30"} />
    </svg>
  );
}

export function PullRequestListEmptyState({
  query,
  filtered,
  searching,
  canLoadMore,
  loadingMore,
  onClearQuery,
  onLoadMore,
}: {
  /** The text being searched for, so the reader is told what was searched rather than guessing. */
  query: string;
  /** True when a state, involvement or project filter is narrowing the list. */
  filtered: boolean;
  /** A search is in flight; the rows on screen are the previous answer. */
  searching: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
}) {
  if (searching) {
    return (
      <Empty className="py-16">
        <BranchMark joined />
        <EmptyHeader>
          <EmptyTitle>Searching every host</EmptyTitle>
          <EmptyDescription>
            Looking for “{query}” across the repositories this page can read.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (query.length > 0) {
    return (
      <Empty className="py-16">
        <BranchMark joined={false} />
        <EmptyHeader>
          <EmptyTitle>Nothing matches “{query}”</EmptyTitle>
          <EmptyDescription>
            The hosts were searched for it. Try fewer words, or search by number, author or branch.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            Clear search
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      <BranchMark joined={false} />
      <EmptyHeader>
        <EmptyTitle>{filtered ? "Nothing under these filters" : "No pull requests"}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Widen the state, involvement or project filter to see more."
            : "Pull requests from every project in this workspace appear here."}
        </EmptyDescription>
      </EmptyHeader>
      {canLoadMore ? (
        <EmptyContent>
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading..." : "Load more pull requests"}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
