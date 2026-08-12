import type { IssueListEntry } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";

import { memo } from "react";

import {
  SourceControlActorAvatar,
  SourceControlActorLabel,
} from "../sourceControl/actorPresentation";
import { ListRow } from "../sourceControl/ListRow";
import { IssueLabelChips, IssueStateGlyph } from "./issuePresentation";

/** Faces, not names: past a few of them the meta line becomes a list nobody reads. */
const ASSIGNEE_FACES = 3;

function IssueRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  matchedElsewhere,
  onSelect,
}: {
  entry: IssueListEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /**
   * A search found this, but in something the row does not show — a body, a comment. Saying so is
   * the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  onSelect: (entry: IssueListEntry) => void;
}) {
  return (
    <ListRow
      glyph={<IssueStateGlyph state={entry.state} stateReason={entry.stateReason} />}
      title={entry.title}
      provider={entry.provider}
      showProvider={showProvider}
      number={entry.number}
      repository={showProjectTitle ? entry.repository : null}
      meta={[
        <SourceControlActorLabel key="author" actor={entry.author} className="max-w-40" />,
        entry.assignees.length > 0 ? (
          <span
            key="assignees"
            className="flex shrink-0 items-center -space-x-1"
            title={`Assigned to ${entry.assignees.map((assignee) => assignee.login).join(", ")}`}
          >
            {entry.assignees.slice(0, ASSIGNEE_FACES).map((assignee) => (
              <SourceControlActorAvatar
                key={assignee.login}
                actor={assignee}
                className="ring-1 ring-background"
              />
            ))}
          </span>
        ) : null,
        // Guarded here rather than left to the chips: a component that renders nothing is still a
        // child, and the meta line would draw a separator in front of it.
        entry.labels.length > 0 ? (
          <IssueLabelChips key="labels" labels={entry.labels} className="shrink-0" />
        ) : null,
      ]}
      matchedElsewhere={matchedElsewhere === true}
      updatedAt={entry.updatedAt}
      trailing={
        entry.commentCount > 0 ? (
          <span
            className="flex items-center gap-1"
            title={`${entry.commentCount.toLocaleString()} comments`}
          >
            <MessageSquareIcon aria-hidden className="size-3" />
            {entry.commentCount.toLocaleString()}
          </span>
        ) : null
      }
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
export const IssueRow = memo(IssueRowImpl);
