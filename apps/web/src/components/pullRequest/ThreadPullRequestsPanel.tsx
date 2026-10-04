import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { ArrowUpRightIcon, EyeIcon, EyeOffIcon, LinkIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { MenuItem } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadIssueRows } from "../chat/ThreadIssueLinks";
import { openLinkThreadItemDialog } from "../LinkThreadItemDialog";
import { LinkedItemRowActions, LinkedItemRowLines, LINKED_ITEM_ROW_CLASS } from "../LinkedItemRow";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PullRequestRowAuthor,
  PullRequestRowBranches,
  PullRequestRowGlyph,
} from "./PullRequestListRow";
import {
  PullRequestDiffStat,
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

const SECTION_HEADING_CLASS = "px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground";

const SOURCE_LABELS: Record<ThreadPullRequestLink["source"], string> = {
  manual: "Linked by you",
  created: "Created from this thread",
  agent: "Linked by the agent",
  stack: "Found in the stack",
  "stack-dismissed": "Dismissed",
};

function ChecksGlyph({
  state,
}: {
  state: NonNullable<ThreadPullRequestLink["snapshot"]>["checksState"] & string;
}) {
  const presentation = pullRequestChecksStatePresentation(state);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-3.5", presentation.toneClassName)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

function LinkRow({
  line,
  threadRef,
  onUnlink,
  onSetWatching,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  onUnlink: (link: ThreadPullRequestLink) => void;
  /** Null when the environment cannot watch pull requests. */
  onSetWatching: ((link: ThreadPullRequestLink, watching: boolean) => void) | null;
}) {
  const openPrLink = useOpenPrLink(threadRef);
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  return (
    <div
      className={LINKED_ITEM_ROW_CLASS}
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? (
        <span aria-hidden className="-ml-2 h-11 w-px shrink-0 self-center bg-border/70" />
      ) : null}
      {snapshot === null ? (
        <PullRequestGlyph.pullRequest
          aria-label="Waiting for host state"
          className="mt-4.5 size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestRowGlyph
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          mergeability={snapshot.mergeability}
          baseBranch={snapshot.baseBranch}
          className="mt-4.5"
        />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="flex min-w-0 flex-1"
      >
        <LinkedItemRowLines
          reference={`${link.repository}#${link.number}`}
          referenceTooltip={
            <>
              {link.host}/{link.repository}#{link.number}
              <br />
              {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
            </>
          }
          updatedAt={snapshot?.updatedAt}
          // Diff counts beside the time, checks and the verdict after the title. Each is absent
          // rather than neutral when the host said nothing, so a row without them reads as
          // unknown, not as fine.
          status={
            snapshot === null ? null : (
              <PullRequestDiffStat
                additions={snapshot.additions ?? 0}
                deletions={snapshot.deletions ?? 0}
                className="font-mono"
              />
            )
          }
          title={snapshot?.title ?? link.repository}
          signals={
            open ? (
              <>
                {watching ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                      <EyeIcon role="img" aria-label="Watching" className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup>
                      Watching: the agent wakes when checks finish, someone comments, or the branch
                      conflicts
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {snapshot?.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
                {snapshot?.reviewDecision ? (
                  <PullRequestReviewDecisionGlyph decision={snapshot.reviewDecision} />
                ) : null}
              </>
            ) : null
          }
          meta={
            stack || snapshot !== null ? (
              <>
                {stack ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                      }
                    >
                      <PullRequestGlyph.stack aria-hidden className="size-3" />
                      {stack.size}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {stack.kind === "native"
                        ? `GitHub stack of ${stack.size}: merging a layer lands the ones below it.`
                        : `${stack.size} pull requests chained by base branch.`}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {snapshot?.author ? (
                  <PullRequestRowAuthor
                    actor={snapshot.author}
                    className="shrink-0"
                    labelClassName="max-w-28"
                  />
                ) : null}
                {snapshot !== null ? (
                  <PullRequestRowBranches head={snapshot.headBranch} base={snapshot.baseBranch} />
                ) : null}
              </>
            ) : null
          }
        />
      </a>
      <LinkedItemRowActions label={`Actions for #${link.number}`}>
        <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
          <LinkIcon className="size-3.5" />
          Copy link
        </MenuItem>
        <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>
          <ArrowUpRightIcon className="size-3.5" />
          Open
        </MenuItem>
        {onSetWatching !== null && open ? (
          <MenuItem onClick={() => onSetWatching(link, !watching)}>
            {watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            {watching ? "Stop watching" : "Watch for changes"}
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => onUnlink(link)}>
          <PullRequestGlyph.unlink className="size-3.5" />
          {link.source === "stack" ? "Dismiss from thread" : "Unlink from thread"}
        </MenuItem>
      </LinkedItemRowActions>
    </div>
  );
}

/** The Linked items tab: the thread's pull requests, then its issues, and a way to link more. */
export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  if (capabilities?.threadPullRequests !== true && capabilities?.issues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Linked items unavailable"
        error="This environment does not support linking pull requests or issues to a thread."
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const issueCount = thread?.issues?.length ?? 0;
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  // A server that keeps one pull request per thread links it from the header, not from here.
  const linkKind = capabilities?.threadPullRequests === true ? null : "issue";
  const openLinkDialog = useCallback(
    () => openLinkThreadItemDialog(threadRef, linkKind),
    [linkKind, threadRef],
  );
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const links = useMemo(() => visibleThreadPullRequests(thread?.pullRequests ?? []), [thread]);
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
  const handleUnlink = useCallback(
    (link: ThreadPullRequestLink) => {
      void unlink({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        },
      });
    },
    [threadRef, unlink],
  );
  const handleSetWatching = useCallback(
    (link: ThreadPullRequestLink, watching: boolean) => {
      void watch({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          watching,
        },
      });
    },
    [threadRef, watch],
  );
  const openCount = useMemo(
    () => links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length,
    [links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0 && issueCount === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked items</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests the agent opens and issues it works on land here. Link one yourself from a
          URL or a number.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link pull request or issue
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {links.length > 0 && issueCount > 0 ? (
            <h3 className={SECTION_HEADING_CLASS}>Pull requests</h3>
          ) : null}
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              onUnlink={handleUnlink}
              onSetWatching={supportsWatch ? handleSetWatching : null}
            />
          ))}
          {issueCount > 0 ? (
            <>
              <h3 className={SECTION_HEADING_CLASS}>Issues</h3>
              <ThreadIssueRows threadRef={threadRef} />
            </>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {links.length > 0 ? `${openCount} open · ${links.length} linked` : null}
          {links.length > 0 && issueCount > 0 ? " · " : null}
          {issueCount > 0 ? `${issueCount} ${issueCount === 1 ? "issue" : "issues"}` : null}
          {lastSynced ? ` · synced ${formatRelativeTimeLabel(lastSynced)}` : ""}
        </span>
        <Button size="xs" variant="ghost" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </footer>
    </div>
  );
}
