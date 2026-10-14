import type { EnvironmentId, IssueRef } from "@t3tools/contracts";

import { useIssueHistory } from "~/state/issues";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestTimelineGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import { IssueLoadMore } from "./IssueLoadMore";

export function IssueHistory({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
}) {
  const history = useIssueHistory(environmentId, reference);
  if (history.items.length === 0 && history.isPending) return <PullRequestTimelineGhost rows={5} />;
  if (history.error !== null && history.items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The history could not be read. {history.error}
      </p>
    );
  }
  if (history.items.length === 0) {
    return <p className="text-xs text-muted-foreground">No history yet.</p>;
  }
  return (
    <div className="space-y-3">
      <ol className="space-y-3 border-l border-border/60 pl-4">
        {history.items.map((event) => (
          <li
            key={event.id}
            className="text-xs [contain-intrinsic-block-size:36px] [content-visibility:auto]"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <PullRequestActorLabel actor={event.actor} className="max-w-40" />
              <span className="text-muted-foreground">{event.kind.replaceAll("_", " ")}</span>
              <time dateTime={event.createdAt} className="ml-auto text-muted-foreground">
                {formatRelativeTimeLabel(event.createdAt)}
              </time>
            </div>
            {event.detail ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {event.detail}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <IssueLoadMore page={history} label="Load more history" />
    </div>
  );
}
