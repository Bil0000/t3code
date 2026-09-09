import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { ListRow } from "../sourceControl/ListRow";
import { Checkbox } from "../ui/checkbox";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { pullRequestLabelColor, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

/**
 * Each slot past the first only appears once the meta line is wide enough to hold it, so a
 * narrow row shows one label and a "+N" while a wide one spreads out up to three. The "+N"
 * rides on whichever pill is the last visible one, and is hidden as soon as the next slot shows.
 */
const LABEL_SLOTS = [
  { pill: "", overflow: "@xl/pr-row-meta:hidden" },
  { pill: "hidden @xl/pr-row-meta:inline-flex", overflow: "@3xl/pr-row-meta:hidden" },
  { pill: "hidden @3xl/pr-row-meta:inline-flex", overflow: "" },
] as const;

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const dot = pullRequestLabelColor(label.color);
        const remaining = labels.length - index - 1;
        return (
          <span
            key={label.name}
            className={cn(
              "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pl-1 pr-1.5 text-[10px] leading-3.5 text-muted-foreground",
              slot.pill,
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="truncate">{label.name}</span>
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function PullRequestRowImpl({
  entry,
  selected,
  selectionChecked,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  statsKey,
  statsRef,
  onSelect,
  onToggleSelection,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  selectionChecked?: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  /**
   * A search found this, but in something the row does not show — a description, a comment, a
   * commit message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  /** Used by the list's shared visibility observer to defer optional line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLButtonElement>;
  onSelect: (entry: EnvironmentPullRequestEntry) => void;
  onToggleSelection?: (entry: EnvironmentPullRequestEntry) => void;
}) {
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div className={cn("group/row relative", onToggleSelection && "[&>button]:pl-10")}>
      <ListRow
        ref={statsRef}
        data-pull-request-stats-key={statsKey}
        glyph={
          <PullRequestStateGlyph
            state={entry.state}
            isDraft={entry.isDraft}
            mergeability={entry.mergeability}
            baseBranch={entry.baseBranch}
          />
        }
        title={entry.title}
        providerName={providerName}
        ProviderIcon={Icon}
        showProvider={showProvider}
        number={entry.number}
        onNumberContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void showPullRequestLinkContextMenu({
            url: entry.url,
            openLabel: openOnHostLabel(entry.provider),
            position: { x: event.clientX, y: event.clientY },
          });
        }}
        repository={showProjectTitle ? entry.repository : null}
        meta={[
          <PullRequestRowLabels key="labels" labels={entry.labels} />,
          environmentLabel ? (
            <span key="environment" className="max-w-32 shrink-0 truncate">
              {environmentLabel}
            </span>
          ) : null,
          <PullRequestActorLabel key="author" actor={entry.author} className="max-w-40 shrink-0" />,
          entry.reviewDecision === "approved" || entry.reviewDecision === "changes-requested" ? (
            <span
              key="review"
              className={cn(
                "shrink-0",
                entry.reviewDecision === "approved"
                  ? "text-emerald-600/90 dark:text-emerald-400/80"
                  : "text-amber-600/90 dark:text-amber-400/80",
              )}
            >
              {entry.reviewDecision === "approved" ? "Approved" : "Changes requested"}
            </span>
          ) : null,
          entry.checksState === undefined ? null : (
            <PullRequestChecksPopover
              key="checks"
              checksState={entry.checksState}
              environmentId={entry.environmentId}
              reference={{
                projectId: entry.projectId,
                repository: entry.repository,
                number: entry.number,
              }}
            />
          ),
        ]}
        matchedElsewhere={matchedElsewhere === true}
        updatedAt={entry.updatedAt}
        trailing={<PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />}
        selected={selected}
        onSelect={() => onSelect(entry)}
      />
      {onToggleSelection ? (
        <Checkbox
          checked={selectionChecked}
          aria-label={
            (selectionChecked ? "Deselect " : "Select ") +
            entry.repository +
            " pull request #" +
            entry.number
          }
          className={cn(
            "absolute top-1/2 left-3 z-10 -translate-y-1/2 transition-opacity",
            selectionChecked
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          )}
          onCheckedChange={() => onToggleSelection(entry)}
        />
      ) : null}
    </div>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
