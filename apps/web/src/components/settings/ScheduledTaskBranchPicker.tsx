import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { usePaginatedBranches } from "../../state/queries";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";

export function ScheduledTaskBranchPicker({
  environmentId,
  cwd,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly value: string;
  readonly onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const branches = usePaginatedBranches({
    environmentId,
    cwd: open ? cwd : null,
    query: deferredQuery,
  });
  const items = branches.refs.map((branch) => branch.name);
  return (
    <Combobox
      items={items}
      filteredItems={items}
      value={value || null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onValueChange={(branch) => {
        if (branch) onChange(branch);
      }}
    >
      <ComboboxTrigger
        id="scheduled-task-branch"
        aria-label="Branch"
        disabled={!cwd}
        render={<Button variant="outline" size="sm" />}
        className="w-full min-w-0 justify-start font-normal"
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{value || "Choose a branch"}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <ComboboxSearchInput
          placeholder="Search branches…"
          aria-label="Search branches"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          {branches.data === null && branches.isPending
            ? "Loading branches…"
            : "No branches found."}
        </ComboboxEmpty>
        <ComboboxList className="max-h-56">
          {branches.refs.map((branch) => (
            <ComboboxItem key={branch.name} value={branch.name}>
              <span className="flex min-w-0 items-center gap-2">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                {branch.isDefault ? (
                  <span className="text-xs text-muted-foreground">Default</span>
                ) : null}
                {branch.isRemote ? (
                  <span className="text-xs text-muted-foreground">Remote</span>
                ) : null}
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
        {branches.error ? (
          <ComboboxStatus>Could not load branches. Reopen to try again.</ComboboxStatus>
        ) : null}
        {branches.data?.nextCursor != null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={branches.isFetchingNextPage}
            onClick={branches.loadNext}
          >
            {branches.isFetchingNextPage ? "Loading…" : "Load more branches"}
          </Button>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
