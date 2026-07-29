import type { ProjectId } from "@t3tools/contracts";
import { ListFilterIcon, SearchIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

/**
 * Plain text pills with a chip behind the active option. Two groups sit on one row —
 * involvement then state — so the row reads as "which pull requests, in which state".
 */
export function PullRequestFilterPills<Value extends string>({
  value,
  options,
  onChange,
}: {
  value: Value;
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm transition-colors",
            option.value === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PullRequestSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search pull requests"
        aria-label="Search pull requests"
        className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
      />
    </div>
  );
}

/**
 * Project scope lives behind the filter icon so the row stays two controls wide. It is the
 * same menu chrome as the detail panel's actions, which also owns its own spacing.
 */
const ALL_PROJECTS_VALUE = "all";

export function PullRequestProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  value: ProjectId | undefined;
  onChange: (projectId: ProjectId | undefined) => void;
}) {
  const selectedTitle = projects.find((project) => project.id === value)?.title;
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:size-7",
          value !== undefined && "text-foreground",
        )}
        aria-label={`Filter by project: ${selectedTitle ?? "All projects"}`}
      >
        <ListFilterIcon className="size-4" />
        {value !== undefined ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
        <MenuRadioGroup
          value={value ?? ALL_PROJECTS_VALUE}
          onValueChange={(next) =>
            onChange(next === ALL_PROJECTS_VALUE ? undefined : (next as ProjectId))
          }
        >
          <MenuRadioItem value={ALL_PROJECTS_VALUE}>All projects</MenuRadioItem>
          {projects.map((project) => (
            <MenuRadioItem key={project.id} value={project.id}>
              <span className="min-w-0 truncate">{project.title}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
