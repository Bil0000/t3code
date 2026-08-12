import type { EnvironmentId, IssueListEntry, ProjectId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { IssuesSurface } from "~/rightPanelStore";
import { issueEnvironment } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";

import type { IssueTabStatus } from "../RightPanelTabs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { IssueDetailPanel, type IssueHandoffTarget } from "./IssueDetailPanel";
import { IssueListGhost } from "./IssueGhosts";
import { issueEntryKey } from "./issueList.logic";
import { IssueRow } from "./IssueRow";

const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 30;
/** The listing's own ceiling. Past it the search is the way to find something, not more rows. */
const MAX_LIMIT = 500;

/**
 * Open above closed, each side keeping the host's recency order. A closed issue is still worth
 * opening — that is why they are listed at all — but it is rarely the one being looked for.
 */
function openFirst(entries: ReadonlyArray<IssueListEntry>): ReadonlyArray<IssueListEntry> {
  return entries.toSorted(
    (left, right) => Number(left.state === "closed") - Number(right.state === "closed"),
  );
}

/**
 * The thread's own issues, beside the conversation. Deliberately not the issues page in a tab: one
 * project, one page, no filters and no URL to keep — everything this needs is the list and the one
 * issue being read, and both live in the same tab.
 */
export function IssuesPanel({
  environmentId,
  projectId,
  selected,
  onSelect,
  handoffTarget,
  onStateChange,
}: {
  environmentId: EnvironmentId;
  /** The thread's project, which is the only repository this panel lists. */
  projectId: ProjectId;
  selected: IssuesSurface["selected"];
  /** Null returns the panel to the list it was picked from. */
  onSelect: (target: NonNullable<IssuesSurface["selected"]> | null) => void;
  handoffTarget: IssueHandoffTarget;
  onStateChange: (status: IssueTabStatus) => void;
}) {
  // Held here rather than in the list, so reading an issue and coming back does not throw away
  // the search that found it — the list is unmounted while the issue is open.
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center border-b border-border/50 px-1.5 py-1">
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground"
            onClick={() => onSelect(null)}
          >
            <ArrowLeftIcon className="size-3.5" />
            All issues
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {/* Hand-offs land in the thread this panel sits beside, so reading an issue and acting
              on it stay one conversation. */}
          <IssueDetailPanel
            key={`${selected.repository}#${selected.number}`}
            environmentId={environmentId}
            reference={{
              projectId: selected.projectId as ProjectId,
              repository: selected.repository,
              number: selected.number,
            }}
            context="thread"
            handoffTarget={handoffTarget}
            onStateChange={onStateChange}
          />
        </div>
      </div>
    );
  }
  return (
    <IssueBrowserList
      environmentId={environmentId}
      projectId={projectId}
      onSelect={onSelect}
      query={query}
      onQuery={setQuery}
      limit={limit}
      onLimit={setLimit}
    />
  );
}

function IssueBrowserList({
  environmentId,
  projectId,
  onSelect,
  query,
  onQuery,
  limit,
  onLimit,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onSelect: (target: NonNullable<IssuesSurface["selected"]>) => void;
  query: string;
  onQuery: (query: string) => void;
  limit: number;
  onLimit: (limit: number) => void;
}) {
  const typed = query.trim();
  // Searching asks the host, which takes a round trip, so the text is held for a moment before it
  // is sent — the same bargain the issues page makes.
  const sent = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);

  const listQuery = useEnvironmentQuery(
    issueEnvironment.list({
      environmentId,
      input: {
        state: "all",
        projectId,
        limit,
        ...(sent ? { query: sent } : {}),
      },
    }),
  );
  const entries = useMemo(() => openFirst(listQuery.data?.entries ?? []), [listQuery.data]);

  // Stable, because the rows are memoized on it.
  const select = useCallback(
    (entry: IssueListEntry) =>
      onSelect({ projectId, repository: entry.repository, number: entry.number }),
    [onSelect, projectId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 py-2">
        <Input
          value={query}
          aria-label="Search issues"
          placeholder="Search issues"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-1 pb-2">
          {entries.length === 0 && listQuery.isPending ? (
            <IssueListGhost rows={7} />
          ) : listQuery.error !== null && listQuery.data === null ? (
            <p className="px-2 text-sm text-muted-foreground">{listQuery.error}</p>
          ) : entries.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              {typed.length > 0
                ? "No issue here matches that."
                : "This repository has no issues to open."}
            </p>
          ) : (
            <>
              {entries.map((entry) => (
                <IssueRow
                  key={issueEntryKey(entry)}
                  entry={entry}
                  selected={false}
                  showProjectTitle={false}
                  showProvider={false}
                  onSelect={select}
                />
              ))}
              {/* Only while there is more to ask for: at the ceiling this could add nothing. */}
              {listQuery.data?.truncated === true && limit < MAX_LIMIT ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={listQuery.isPending}
                  onClick={() => onLimit(Math.min(limit + PAGE_SIZE, MAX_LIMIT))}
                >
                  {listQuery.isPending ? "Loading..." : "Load more"}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
