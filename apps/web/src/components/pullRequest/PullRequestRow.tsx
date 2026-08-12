import type { PullRequestListEntry } from "@t3tools/contracts";

import { memo } from "react";

import { ListRow } from "../sourceControl/ListRow";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  matchedElsewhere,
  onSelect,
}: {
  entry: PullRequestListEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /**
   * A search found this, but in something the row does not show — a description, a comment, a
   * commit message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  onSelect: (entry: PullRequestListEntry) => void;
}) {
  return (
    <ListRow
      glyph={
        <PullRequestStateGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          baseBranch={entry.baseBranch}
        />
      }
      title={entry.title}
      provider={entry.provider}
      showProvider={showProvider}
      number={entry.number}
      repository={showProjectTitle ? entry.repository : null}
      meta={[
        <PullRequestActorLabel key="author" actor={entry.author} className="max-w-40 shrink-0" />,
        <span
          key="branch"
          className="truncate"
          title={`${entry.headBranch} to ${entry.baseBranch}`}
        >
          {entry.headBranch}
        </span>,
      ]}
      matchedElsewhere={matchedElsewhere === true}
      updatedAt={entry.updatedAt}
      trailing={<PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />}
      selected={selected}
      onSelect={() => onSelect(entry)}
    />
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
