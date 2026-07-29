import type { PullRequestListEntry } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

export function PullRequestRow({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  onSelect,
}: {
  entry: PullRequestListEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  onSelect: (entry: PullRequestListEntry) => void;
}) {
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestStateGlyph
        state={entry.state}
        isDraft={entry.isDraft}
        mergeability={entry.mergeability}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{entry.title}</span>
        <PullRequestMetaLine className="mt-0.5 text-xs text-muted-foreground/70">
          <span className="flex shrink-0 items-center gap-1">
            {showProvider ? <Icon aria-label={providerName} className="size-3" /> : null}#
            {entry.number}
          </span>
          {showProjectTitle ? <span className="truncate">{entry.repository}</span> : null}
          <span className="truncate">{entry.author?.login ?? "ghost"}</span>
          <span className="truncate" title={`${entry.headBranch} to ${entry.baseBranch}`}>
            {entry.headBranch}
          </span>
        </PullRequestMetaLine>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground/70 tabular-nums">
        <span>{formatRelativeTimeLabel(entry.updatedAt)}</span>
        <PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />
      </span>
    </button>
  );
}
