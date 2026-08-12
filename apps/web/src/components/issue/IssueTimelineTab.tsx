import type { IssueDetailView, SourceControlActor } from "@t3tools/contracts";
import { ChevronDownIcon, CircleDotIcon, ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SourceControlActorAvatar } from "../sourceControl/actorPresentation";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  buildIssueTimeline,
  groupIssueTimelineConversations,
  type IssueTimelineEntry,
} from "./issueDetail.logic";

function ActorName({ actor }: { actor: SourceControlActor | null }) {
  return <span className="font-semibold text-foreground">{actor?.login ?? "ghost"}</span>;
}

function TimelineMarker({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ActorTimelineMarker({
  actors,
  className,
  fallback,
  muted = false,
}: {
  actors: ReadonlyArray<SourceControlActor>;
  className?: string | undefined;
  fallback: ReactNode;
  muted?: boolean;
}) {
  const actor = actors[0];
  return actor === undefined ? (
    <TimelineMarker className={className}>
      <span className="flex size-7 items-center justify-center bg-background text-muted-foreground">
        {fallback}
      </span>
    </TimelineMarker>
  ) : (
    <TimelineMarker className={className}>
      <SourceControlActorAvatar
        actor={actor}
        className={cn(
          "size-7 bg-muted text-[9px] transition-opacity",
          muted && "opacity-45 grayscale",
        )}
      />
    </TimelineMarker>
  );
}

function ConversationCard({
  entry,
  cwd,
  onOpen,
}: {
  entry: IssueTimelineEntry;
  cwd: string;
  onOpen: (url: string) => void;
}) {
  const url = entry.url;
  return (
    <article className="py-2">
      <div className="flex min-w-0 items-start gap-2 px-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={entry.actor} />
            <span className="text-muted-foreground">{entry.title}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {formatRelativeTimeLabel(entry.at)}
          </p>
        </div>
        {url === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
            aria-label="Open this comment on the host"
            onClick={() => onOpen(url)}
          >
            <ExternalLinkIcon className="size-3" />
          </Button>
        )}
      </div>
      {entry.body === null ? null : (
        <div className="px-2 pb-2">
          <HostMarkdown className="mt-3" text={entry.body} cwd={cwd} />
        </div>
      )}
    </article>
  );
}

function uniqueConversationActors(entries: ReadonlyArray<IssueTimelineEntry>) {
  const actors = new Map<string, SourceControlActor>();
  for (const entry of entries) {
    const actor = entry.actor;
    if (actor !== null && !actors.has(actor.login)) actors.set(actor.login, actor);
  }
  return [...actors.values()];
}

function ConversationGroup({
  entries,
  cwd,
  onOpen,
}: {
  entries: ReadonlyArray<IssueTimelineEntry>;
  cwd: string;
  onOpen: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const actors = uniqueConversationActors(entries);
  const first = entries[0];
  if (first === undefined) return null;

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={actors}
        className="top-6"
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!open}
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div>
          <CollapsibleTrigger
            className={cn(
              "flex w-full min-w-0 items-center gap-3 py-2 text-left transition-opacity hover:opacity-100",
              open ? "text-foreground opacity-100" : "text-muted-foreground opacity-55",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">
                {entries.length.toLocaleString()} {entries.length === 1 ? "comment" : "comments"}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {actors.length.toLocaleString()} {actors.length === 1 ? "author" : "authors"} ·{" "}
                {formatRelativeTimeLabel(first.at)}
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {open ? (
              <div className="mt-1 space-y-1">
                {entries.map((entry) => (
                  <ConversationCard key={entry.id} entry={entry} cwd={cwd} onOpen={onOpen} />
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </div>
  );
}

function TimelineEvent({ entry }: { entry: IssueTimelineEntry }) {
  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={entry.actor === null ? [] : [entry.actor]}
        fallback={<CircleDotIcon className="size-3.5" />}
      />
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
                cwd={detail.workspaceRoot}
                onOpen={openOnHost}
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
