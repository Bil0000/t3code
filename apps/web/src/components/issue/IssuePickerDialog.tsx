import type { EnvironmentId, IssueListEntry, ProjectId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
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
 * Picks one issue of the thread's own project to read beside the conversation. Deliberately not
 * the issues page in a dialog: one project, one page, no filters — what the panel needs to turn
 * "open an issue" into a tab.
 */
export function IssuePickerDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  /** The thread's project, which is the only repository this picker offers. */
  projectId: ProjectId;
  onSelect: (entry: IssueListEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const typed = query.trim();
  // Searching asks the host, which takes a round trip, so the text is held for a moment before it
  // is sent — the same bargain the issues page makes.
  const sent = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);

  // Read only while the dialog is up: a picker nobody has opened must not cost a host request.
  const listQuery = useEnvironmentQuery(
    open
      ? issueEnvironment.list({
          environmentId,
          input: {
            state: "all",
            projectId,
            limit,
            ...(sent ? { query: sent } : {}),
          },
        })
      : null,
  );
  const entries = useMemo(() => openFirst(listQuery.data?.entries ?? []), [listQuery.data]);

  const reset = () => {
    setQuery("");
    setLimit(PAGE_SIZE);
  };
  const setOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  // Stable, because the rows are memoized on it.
  const select = useCallback(
    (entry: IssueListEntry) => {
      setQuery("");
      setLimit(PAGE_SIZE);
      onSelect(entry);
      onOpenChange(false);
    },
    [onOpenChange, onSelect],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Open an issue</DialogTitle>
          <DialogDescription>
            From this thread's repository, as a tab beside the conversation.
          </DialogDescription>
          <Input
            autoFocus
            value={query}
            aria-label="Search issues"
            placeholder="Search issues"
            onChange={(event) => setQuery(event.target.value)}
          />
        </DialogHeader>
        <DialogPanel className="min-h-72 space-y-0.5">
          {entries.length === 0 && listQuery.isPending ? (
            <IssueListGhost rows={6} />
          ) : listQuery.error !== null && listQuery.data === null ? (
            <p className="text-sm text-muted-foreground">{listQuery.error}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
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
                  onClick={() => setLimit(Math.min(limit + PAGE_SIZE, MAX_LIMIT))}
                >
                  {listQuery.isPending ? "Loading..." : "Load more"}
                </Button>
              ) : null}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
