import type { PullRequestDetail } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "~/timestampFormat";

import { buildPullRequestTimeline } from "./pullRequestDetail.logic";

export function PullRequestTimelineTab({ detail }: { detail: PullRequestDetail }) {
  const events = buildPullRequestTimeline(detail);
  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {events.map((event) => (
          <article key={event.id} className="relative pb-5 text-sm">
            <span
              aria-hidden
              className="absolute -left-[1.55rem] top-1 size-2 rounded-full border border-border bg-background"
            />
            <div className="font-medium">{event.title}</div>
            <div className="text-xs text-muted-foreground">{formatRelativeTimeLabel(event.at)}</div>
            {event.body ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                {event.body}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
