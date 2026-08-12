/**
 * What the list shows when it has no rows to show.
 *
 * The drawing is the page's own subject rather than a stock empty box: the ring the state glyph
 * wears, with the line of text that would sit beside it left unwritten, in the stroke language
 * the row icons already use.
 *
 * An empty page and an unread one look the same, so the states that are showing a host's answer
 * offer to ask for it again. The two that are not — a search still in flight, and a workspace
 * with no project to read from — leave the button out, since pressing it could only repeat what
 * is already happening or ask nobody.
 */
import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { IssueListGhost } from "./IssueGhosts";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * Drawn at the weight of the icons beside it rather than as an illustration with its own palette,
 * so an empty page reads as the same surface with nothing on it. The ring is whole — an issue is
 * a thing somebody opened, and there is nothing broken about not having one — while the row it
 * would sit on trails off into the space where its title would be.
 */
function IssueMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 72"
      className="h-20 w-32 text-muted-foreground/60"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="24" cy="36" r="12" />
      <circle cx="24" cy="36" r="3.5" fill="currentColor" fillOpacity={0.25} stroke="none" />
      {/* The title line of the row that is not there, and the meta line under it, withheld. */}
      <path d="M48 30h60" className="text-muted-foreground/30" stroke="currentColor" />
      <path
        d="M48 44h34"
        strokeDasharray="2 7"
        className="text-muted-foreground/50"
        stroke="currentColor"
      />
    </svg>
  );
}

export function IssueListEmptyState({
  query,
  filtered,
  searching,
  hasProjects,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onLoadMore,
  onRefresh,
}: {
  /** The text being searched for, so the reader is told what was searched rather than guessing. */
  query: string;
  /** True when a state, involvement, host or project filter is narrowing the list. */
  filtered: boolean;
  /** A search is in flight; the rows on screen are the previous answer. */
  searching: boolean;
  /**
   * Whether this environment holds a project at all. The list is assembled from the projects'
   * remotes, so without one there is no host to ask and no filter or search that could help.
   */
  hasProjects: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  /** A re-read of the hosts is already running, from here or from the header. */
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  // Ahead of the search and the filters, because neither can produce a row until a project does.
  if (!hasProjects) {
    return (
      <Empty className="py-16">
        <IssueMark />
        <EmptyHeader>
          <EmptyTitle>No projects in this workspace</EmptyTitle>
          <EmptyDescription>
            Add a project, and the issues from its repository appear here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon className="size-3.5" />
            Add project
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (searching) {
    // The same ghost the first load wears, so a search on its way and a list on its way are
    // one state to the eye — with the question named where the group headers usually speak.
    return (
      <IssueListGhost
        rows={5}
        caption={`Searching every host for “${query.length > 48 ? `${query.slice(0, 48)}…` : query}”`}
      />
    );
  }

  if (query.length > 0) {
    return (
      <Empty className="py-16">
        <IssueMark />
        <EmptyHeader>
          {/* A pasted paragraph is still a search, but it is not a title. */}
          <EmptyTitle>
            Nothing matches “{query.length > 48 ? `${query.slice(0, 48)}…` : query}”
          </EmptyTitle>
          <EmptyDescription>
            The hosts were searched for it. Try fewer words, or search by number, author or label.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            Clear search
          </Button>
          {/* The hosts answered this query once; an issue filed since then would answer
              differently, and nothing on screen says which of the two the reader is looking at. */}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? "Checking..." : "Check again"}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      <IssueMark />
      <EmptyHeader>
        <EmptyTitle>{filtered ? "Nothing under these filters" : "No issues"}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Widen the state, involvement or project filter to see more."
            : "Issues from every project in this workspace appear here."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading..." : "Load more issues"}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon className="size-3.5" />
          {refreshing ? "Checking..." : "Check again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
