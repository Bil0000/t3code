import type { IssueDetailView } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";

import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ConversationGroup } from "../sourceControl/ConversationGroup";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { ActorName, IconMarker } from "../sourceControl/TimelineRail";
import {
  buildIssueTimeline,
  groupIssueTimelineConversations,
  type IssueTimelineEntry,
} from "./issueDetail.logic";

/**
 * An event wears the issue glyph rather than whoever caused it. A face here is a filled disc on
 * every row of the rail, which reads as a column of blobs the line runs between; the glyph keeps
 * the rail the continuous thing and leaves the avatars to say what they say on a pull request —
 * that a run of comments has people in it.
 */
function TimelineEvent({ entry }: { entry: IssueTimelineEntry }) {
  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <IconMarker icon={<CircleDotIcon className="size-3.5" />} />
      <div className="py-1.5 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ActorName actor={entry.actor} />
          <span className="min-w-0 text-muted-foreground">{entry.title}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTimeLabel(entry.at)}
        </div>
      </div>
    </div>
  );
}

export function IssueTimelineTab({
  detail,
  order,
}: {
  detail: IssueDetailView;
  /** The rail is built oldest first, which is how an issue was written and how it reads. */
  order: "newest" | "oldest";
}) {
  const entries = buildIssueTimeline(detail);
  const rows = groupIssueTimelineConversations(order === "oldest" ? entries : entries.toReversed());
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          <span aria-hidden className="absolute bottom-5 left-[15px] top-1 w-px bg-border/45" />
          {rows.map((row) =>
            row.kind === "comments" ? (
              <ConversationGroup
                key={`comments:${row.entries[0]?.id ?? "empty"}`}
                entries={row.entries}
                onOpen={openOnHost}
                renderBody={(entry) =>
                  entry.body === null ? null : (
                    <HostMarkdown text={entry.body} cwd={detail.workspaceRoot} />
                  )
                }
              />
            ) : (
              <TimelineEvent key={row.entry.id} entry={row.entry} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
