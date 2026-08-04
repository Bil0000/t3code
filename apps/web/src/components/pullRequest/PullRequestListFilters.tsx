import type {
  ProjectId,
  PullRequestProviderSummary,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { ListFilterIcon, SearchIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";

/**
 * The shell every filter group shares: an inset track that groups its options into one control,
 * so a row of them reads as one question with one answer rather than as loose words.
 */
const FILTER_GROUP_CLASS =
  "inline-flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5 dark:bg-white/5";

/** The option itself, with the selected one lifted onto the surface rather than tinted. */
const filterOptionClass = (selected: boolean, disabled = false) =>
  cn(
    "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-sm whitespace-nowrap transition-colors",
    selected ? "bg-background text-foreground shadow-sm dark:bg-white/10" : "text-muted-foreground",
    disabled ? "cursor-not-allowed opacity-45" : !selected && "hover:text-foreground",
  );

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /**
   * Carries the option's own tone, so an icon reads the same here as it does on a row. Left
   * uncoloured, which lets the pill's selected state stay the thing the eye follows.
   */
  readonly Icon: LucideIcon;
}

export function PullRequestFilterPills<Value extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  label: string;
  onChange: (value: Value) => void;
}) {
  return (
    <div className={FILTER_GROUP_CLASS} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={filterOptionClass(option.value === value)}
        >
          <option.Icon aria-hidden className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Host switcher, in the same pill chrome as the filters beside it. It only renders once a
 * workspace actually spans more than one host: with a single host there is nothing to switch
 * between, and an always-visible control would only raise the question. It also renders while
 * a host is selected whatever the list says, so a link that arrives already filtered still
 * offers the way back out.
 *
 * A host that cannot be read stays in the row, disabled, carrying the server's reason as its
 * title — the projects on it are missing from the list either way, and a dimmed pill explains
 * that where an absent one would not.
 */
export function PullRequestProviderFilter({
  providers,
  value,
  expectedHostCount,
  onChange,
}: {
  providers: ReadonlyArray<PullRequestProviderSummary>;
  value: SourceControlProviderKind | undefined;
  /**
   * How many hosts the workspace's own projects point at, which is known before the list is.
   * Used only to hold this row's place while it loads, so the row does not appear from nowhere
   * and push the page down — never to claim a host is usable before the server has said so.
   */
  expectedHostCount: number;
  onChange: (provider: SourceControlProviderKind | undefined) => void;
}) {
  if (providers.length === 0 && value === undefined) {
    return expectedHostCount < 2 ? null : (
      <div className={FILTER_GROUP_CLASS} aria-hidden>
        {/* One more than the hosts, for the "All" pill that will sit in front of them. */}
        {Array.from({ length: expectedHostCount + 1 }, (_, index) => (
          <Skeleton key={index} className="h-7 w-20 rounded-[7px]" />
        ))}
      </div>
    );
  }
  if (providers.length < 2 && value === undefined) {
    return null;
  }
  return (
    <div className={FILTER_GROUP_CLASS} role="group" aria-label="Filter by host">
      <button
        type="button"
        aria-pressed={value === undefined}
        onClick={() => onChange(undefined)}
        className={filterOptionClass(value === undefined)}
      >
        All
      </button>
      {providers.map((provider) => {
        const { Icon, providerName } = getSourceControlPresentationForKind(provider.kind);
        const active = provider.kind === value;
        return (
          <button
            key={provider.kind}
            type="button"
            aria-pressed={active}
            disabled={!provider.configured}
            title={provider.configured ? providerName : (provider.detail ?? undefined)}
            onClick={() => onChange(provider.kind)}
            // Opacity rather than a muted colour: the icons are brand-coloured, so text colour
            // alone would leave a disabled host looking active.
            className={filterOptionClass(active, !provider.configured)}
          >
            <Icon className="size-3.5" />
            {providerName}
          </button>
        );
      })}
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
        // Tracks the shared input's height at both widths, so it stays level with the icon
        // button beside it rather than towering over it on wide screens.
        className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:h-8"
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
          // The icon-button size that pairs with a full-height input, so the two read as one strip.
          "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:size-8",
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
