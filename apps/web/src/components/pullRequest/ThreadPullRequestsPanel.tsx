import {
  SourceControlProviderKind,
  type ScopedThreadRef,
  type ThreadIssueLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  ArrowUpRightIcon,
  CircleDotIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { findProjectForLink, openLinkInBrowser } from "~/lib/openIssueLink";
import { shouldOpenPullRequestExternally, useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowBranches,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import {
  PullRequestDiffStat,
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { resolveIssueState } from "../issue/issuePresentation";

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

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Out of the row's flow, so no row reserves a column for a button only the hovered one
    // shows. It sits over the right end of the second line on the row's own hover color,
    // fading in from the left, so it covers the time and leaves the diff counts alone.
    <span
      className={cn(
        "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
        "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
        // Hidden means untouchable too: on a touch screen there is no hover, and an invisible
        // layer over the right of the row would otherwise swallow the tap meant for the link.
        "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
        "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
        "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
      )}
    >
      <span aria-hidden className="absolute inset-0 bg-accent/60" />
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-micro" aria-label={label} className="relative">
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom">
          {children}
        </MenuPopup>
      </Menu>
    </span>
  );
}

const isSourceControlProvider = Schema.is(SourceControlProviderKind);

function IssueRow({
  issue,
  onOpen,
  onUnlink,
}: {
  issue: ThreadIssueLink;
  onOpen: (issue: ThreadIssueLink) => void;
  onUnlink: (issue: ThreadIssueLink) => void;
}) {
  const presentation =
    issue.state === undefined ? null : resolveIssueState({ state: issue.state, stateReason: null });
  const Icon = presentation?.Icon ?? CircleDotIcon;
  const openIssue = (event: MouseEvent<HTMLElement>) => {
    if (shouldOpenPullRequestExternally(event)) return;
    event.preventDefault();
    onOpen(issue);
  };
  return (
    <div className={cn(PULL_REQUEST_ROW_CLASS, "relative pl-2 hover:bg-accent/60")}>
      <Icon
        role="img"
        aria-label={presentation?.label ?? "Issue"}
        className={cn("size-4 shrink-0", presentation?.toneClassName ?? "text-muted-foreground")}
      />
      <a href={issue.url} onClick={openIssue} className="flex min-w-0 flex-1">
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{issue.number}</span>}
          title={issue.title}
          meta={
            <span className="flex min-w-0 max-w-32 font-mono">
              <MiddleTruncate value={issue.repository} />
            </span>
          }
        />
      </a>
      <RowMenu label={`Actions for issue #${issue.number}`}>
        <MenuItem onClick={() => void writeTextToClipboard(issue.url, "link")}>
          <LinkIcon className="size-3.5" />
          Copy link
        </MenuItem>
        <MenuItem onClick={() => openLinkInBrowser(issue.url)}>
          <ArrowUpRightIcon className="size-3.5" />
          Open on host
        </MenuItem>
        <MenuItem onClick={() => onUnlink(issue)}>
          <PullRequestGlyph.unlink className="size-3.5" />
          Unlink from thread
        </MenuItem>
      </RowMenu>
    </div>
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
      className={cn(PULL_REQUEST_ROW_CLASS, "relative hover:bg-accent/60")}
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {snapshot === null ? (
        <PullRequestGlyph.pullRequest
          aria-label="Waiting for host state"
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestRowGlyph
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          mergeability={snapshot.mergeability}
          baseBranch={snapshot.baseBranch}
        />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="flex min-w-0 flex-1"
      >
        <PullRequestRowLines
          number={
            <Tooltip>
              <TooltipTrigger render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}>
                #{link.number}
              </TooltipTrigger>
              <TooltipPopup>
                {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
              </TooltipPopup>
            </Tooltip>
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
          // Match the full PR list: diff counts up top, checks under the lifecycle glyph, the
          // verdict by the author. Each is absent rather than neutral when the host said
          // nothing, so a row without them reads as unknown, not as fine.
          status={
            <PullRequestDiffStat
              additions={snapshot?.additions ?? 0}
              deletions={snapshot?.deletions ?? 0}
              className="font-mono"
            />
          }
          meta={
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
                <>
                  {/* Cut in the middle: rows from one owner differ in the repository name at the
                      end, which a tail cut would hide. */}
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex min-w-0 max-w-32 font-mono" />}>
                      <MiddleTruncate value={link.repository} showTitle={false} />
                    </TooltipTrigger>
                    <TooltipPopup>{link.repository}</TooltipPopup>
                  </Tooltip>
                  <PullRequestRowBranches head={snapshot.headBranch} base={snapshot.baseBranch} />
                </>
              ) : (
                <span className="truncate font-mono">
                  {link.host}/{link.repository}
                </span>
              )}
            </>
          }
          updatedAt={snapshot?.updatedAt}
        />
      </a>
      <RowMenu label={`Actions for #${link.number}`}>
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
      </RowMenu>
    </div>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  if (capabilities?.threadPullRequests !== true && capabilities?.issues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Linked items unavailable"
        error="This environment does not support multiple linked pull requests."
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const openLinkDialog = useCallback(() => openLinkPullRequestDialog(threadRef), [threadRef]);
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: true });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const supportsPullRequests = capabilities?.threadPullRequests === true;
  const supportsIssues = capabilities?.issues === true;
  const projects = useProjects();
  const links = useMemo(
    () => (supportsPullRequests ? visibleThreadPullRequests(thread?.pullRequests ?? []) : []),
    [supportsPullRequests, thread],
  );
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
  const issues = useMemo(() => thread?.issues ?? [], [thread]);
  const handleOpenIssue = useCallback(
    (issue: ThreadIssueLink) => {
      const environmentProjects = projects.filter(
        (candidate) => candidate.environmentId === threadRef.environmentId,
      );
      const project =
        issue.projectId !== undefined
          ? environmentProjects.find((candidate) => candidate.id === issue.projectId)
          : isSourceControlProvider(issue.provider)
            ? findProjectForLink(environmentProjects, issue)
            : environmentProjects.find((candidate) => candidate.id === thread?.projectId);
      if (!supportsIssues || project === undefined) {
        openLinkInBrowser(issue.url);
        return;
      }
      useRightPanelStore.getState().openIssue(threadRef, {
        projectId: project.id,
        provider: issue.provider,
        repository: issue.repository,
        number: issue.number,
      });
    },
    [projects, supportsIssues, thread?.projectId, threadRef],
  );
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
  const handleUnlinkIssue = useCallback(
    (issue: ThreadIssueLink) => {
      void updateMetadata({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          issueUnlink: {
            provider: issue.provider,
            repository: issue.repository,
            number: issue.number,
            url: issue.url,
          },
        },
      });
    },
    [threadRef, updateMetadata],
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
    () =>
      links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length +
      issues.filter((issue) => issue.state !== "closed").length,
    [issues, links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0 && issues.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked items</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests and issues linked to this thread appear here. Paste a URL or enter a number
          to link one.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              onUnlink={handleUnlink}
              onSetWatching={supportsWatch ? handleSetWatching : null}
            />
          ))}
          {issues.map((issue) => (
            <IssueRow
              key={issue.url}
              issue={issue}
              onOpen={handleOpenIssue}
              onUnlink={handleUnlinkIssue}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {openCount} open · {links.length + issues.length} linked
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
