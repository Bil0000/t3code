import type { PullRequestDetailView } from "@t3tools/contracts";
import {
  FileCode2Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "lucide-react";

import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ConversationGroup } from "../sourceControl/ConversationGroup";
import { ActorName, ActorTimelineMarker, IconMarker } from "../sourceControl/TimelineRail";
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  type PullRequestTimelineEvent,
} from "./pullRequestDetail.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestDiffStat } from "./pullRequestPresentation";

function TimelineBody({ body, markdown, cwd }: { body: string; markdown: boolean; cwd: string }) {
  return markdown ? (
    <PullRequestMarkdown text={body} cwd={cwd} />
  ) : (
    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{body}</p>
  );
}

function friendlyReviewState(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  return words.replace(/^\w/u, (letter) => letter.toUpperCase());
}

function ReviewStateBadge({ state }: { state: string }) {
  return (
    <span className="text-[10px] font-medium text-muted-foreground">
      {friendlyReviewState(state)}
    </span>
  );
}

function CommitEvent({
  event,
  onOpen,
}: {
  event: PullRequestTimelineEvent;
  onOpen: (oid: string) => void;
}) {
  return (
    <button
      type="button"
      className="group relative mb-5 block w-full rounded-sm pl-12 text-left outline-none [contain-intrinsic-block-size:48px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`View commit ${event.id}`}
      onClick={() => onOpen(event.id)}
    >
      <ActorTimelineMarker
        actors={event.commitAuthors}
        fallback={<GitCommitHorizontalIcon className="size-3.5" />}
      />
      <div className="flex min-w-0 items-center gap-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
            {event.body ?? "Untitled commit"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <code className="font-mono">{event.id.slice(0, 7)}</code>
            <span>{formatRelativeTimeLabel(event.at)}</span>
          </div>
        </div>
        {event.additions !== null && event.deletions !== null ? (
          <PullRequestDiffStat
            additions={event.additions}
            deletions={event.deletions}
            className="ml-auto shrink-0 font-mono text-[10px]"
          />
        ) : null}
      </div>
    </button>
  );
}

function LifecycleEvent({ event }: { event: PullRequestTimelineEvent }) {
  const presentation =
    event.kind === "opened"
      ? {
          icon: <GitPullRequestIcon className="size-3.5" />,
          label: "Pull request opened",
        }
      : event.kind === "merged"
        ? {
            icon: <GitMergeIcon className="size-3.5" />,
            label: "Pull request merged",
          }
        : {
            icon: <GitPullRequestClosedIcon className="size-3.5" />,
            label: "Pull request closed",
          };

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <IconMarker icon={presentation.icon} />
      <div className="py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.actor ? <ActorName actor={event.actor} /> : null}
          <span className="font-semibold text-foreground">{presentation.label}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTimeLabel(event.at)}
        </div>
      </div>
    </div>
  );
}

export function PullRequestTimelineTab({
  detail,
  order,
  onOpenCommit,
}: {
  detail: PullRequestDetailView;
  order: "newest" | "oldest";
  onOpenCommit: (oid: string) => void;
}) {
  const events = buildPullRequestTimeline(detail);
  const orderedEvents = order === "newest" ? events : events.toReversed();
  const rows = groupPullRequestTimelineConversations(orderedEvents);
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          <span aria-hidden className="absolute bottom-5 left-[15px] top-1 w-px bg-border/45" />
          {rows.map((row) => {
            if (row.kind === "comments") {
              return (
                <ConversationGroup
                  key={`comments:${row.events[0]?.id ?? "empty"}`}
                  entries={row.events}
                  onOpen={openOnHost}
                  renderBadge={(event) =>
                    event.reviewState ? <ReviewStateBadge state={event.reviewState} /> : null
                  }
                  renderMeta={(event) =>
                    event.path ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate">{event.path}</span>
                      </span>
                    ) : null
                  }
                  renderBody={(event) =>
                    event.body ? (
                      <TimelineBody
                        body={event.body}
                        markdown={event.markdown}
                        cwd={detail.workspaceRoot}
                      />
                    ) : null
                  }
                />
              );
            }
            const event = row.event;
            if (event.kind === "commit") {
              return <CommitEvent key={event.id} event={event} onOpen={onOpenCommit} />;
            }
            return <LifecycleEvent key={event.id} event={event} />;
          })}
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <GitPullRequestIcon className="mb-2 size-5" />
            <p className="text-xs">No activity yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
