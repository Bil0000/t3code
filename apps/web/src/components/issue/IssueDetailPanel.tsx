import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueAction,
  IssueCloseReason,
  IssueLinkedPullRequest,
  IssueRef,
  IssueState,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  ChevronDownIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilLineIcon,
  RefreshCwIcon,
  TagIcon,
  UserPlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SourceControlActorLabel, SourceControlMetaLine } from "../sourceControl/actorPresentation";
import { handoffPrompt, readableFailure } from "../sourceControl/handoff";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { IssueActivityUnavailableState } from "./IssueActivityUnavailableState";
import {
  buildAskAboutIssueHandoff,
  buildAttachIssueContext,
  buildExplainIssueHandoff,
  buildSolveIssueHandoff,
  issueHandoffReviewComments,
  type IssueHandoff,
  type IssueHandoffSource,
} from "./issueDetail.logic";
import { IssueDetailGhost, IssueTimelineGhost } from "./IssueGhosts";
import { IssueSummaryTab } from "./IssueSummaryTab";
import { IssuesUnavailableState } from "./IssuesUnavailableState";
import { IssueTimelineTab } from "./IssueTimelineTab";
import { resolveIssueState } from "./issuePresentation";

/** An issue has no patch to read, so there is no third tab here as there is on a change request. */
type DetailTab = "summary" | "timeline";

const ACTION_SUCCESS_LABELS: Record<IssueAction, string> = {
  close: "Issue closed",
  reopen: "Issue reopened",
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
const ACTION_FAILURE_LABELS: Record<IssueAction, string> = {
  close: "Could not close this issue",
  reopen: "Could not reopen this issue",
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<IssueAction, string> = {
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, or that you opened it, and that the tracker is still on.",
};

/** The choice reads as the whole action, because that is what pressing it does. */
const CLOSE_REASON_LABELS: Record<IssueCloseReason, string> = {
  completed: "Close as completed",
  "not-planned": "Close as not planned",
};

/** The same reason inside the confirmation's sentence, where the verb is already said. */
const CLOSE_REASON_PHRASES: Record<IssueCloseReason, string> = {
  completed: " as completed",
  "not-planned": " as not planned",
};

/** Named for the host rather than "externally": the point is where you will land. */
const OPEN_ON_HOST_LABELS: Partial<Record<string, string>> = {
  github: "Open on GitHub",
  gitlab: "Open on GitLab",
  bitbucket: "Open on Bitbucket",
  "azure-devops": "Open on Azure DevOps",
};

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
];

/**
 * Where a hand-off from this panel lands. Beside a thread it is that thread's own composer, so
 * reading an issue and asking about it stay one conversation; on a page there is no conversation
 * to join, and the issue's own project gets a new thread.
 */
export type IssueHandoffTarget =
  | { readonly kind: "new-thread" }
  | {
      readonly kind: "existing-thread";
      /** Which project the thread is standing in, which is not always the issue's own. */
      readonly projectRef: ScopedProjectRef;
      /** The composer to write into: a live thread, or the draft one that has yet to become one. */
      readonly draftId: ScopedThreadRef | DraftId;
    };

/**
 * What the last hand-off wrote into each composer, kept outside React because the panel that wrote
 * it is closed by the time the next one opens. It is how a prompt the reader has since edited is
 * told apart from the one they were handed: only the sentence still exactly as written may be
 * replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

const draftKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

export function IssueDetailPanel({
  environmentId,
  reference,
  handoffTarget,
  refreshToken: forcedRefreshToken = 0,
  onActed,
  onStateChange,
  onOpenLinkedPullRequest,
  context = "page",
  chromeVariant = "full",
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Where "Solve", "Ask" and the rest put what they write. */
  handoffTarget: IssueHandoffTarget;
  /**
   * Bumped by whatever holds the panel when a reader asks for everything on screen to be read
   * again. The panel owns its own reads, so the page cannot refresh them for it — it says when,
   * and this says it.
   */
  refreshToken?: number;
  /**
   * An action changed this issue on the host, so a list showing it is now out of date. Told
   * rather than assumed: only the page knows whether it is showing one.
   */
  onActed?: () => void;
  /** Keeps compact chrome, such as the right-panel tab, in step with refreshed host state. */
  onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: IssueState;
    stateReason: IssueCloseReason | null;
  }) => void;
  /**
   * Opens one of the change requests that reference this issue, as a peer tab beside it. Supplied
   * by whoever mounted the panel, because only they know which panel the tab belongs in; without
   * one the row opens it on the host instead, which is never a dead control.
   */
  onOpenLinkedPullRequest?: (link: IssueLinkedPullRequest) => void;
  /**
   * Beside a thread the header is narrow and the reader is already in the conversation a hand-off
   * would land in, so "Solve" stays in the menu with the other three; on a page it is the reason
   * to have opened the issue at all, and rides the button row.
   */
  context?: "page" | "thread";
  /**
   * How the metadata above the content behaves: `full` keeps every row pinned; `collapse`
   * folds the whole of it into the top row once the active tab scrolls, and unfolds at the
   * top — the chrome spends its height on what is being read.
   */
  chromeVariant?: "full" | "collapse";
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  // Oldest first, unlike a change request: an issue is an argument written from its opening
  // towards whatever was settled, and reading it backwards is reading the conclusion first.
  const [timelineOrder, setTimelineOrder] = useState<"oldest" | "newest">("oldest");
  // Both live here rather than in the tab that shows them, because the menu that opens them is
  // in this header and the summary is a tab away when it is pressed.
  const [editing, setEditing] = useState(false);
  const [openPicker, setOpenPicker] = useState<"labels" | "assignees" | null>(null);
  // Every tab the reader has opened stays mounted behind the active one: a long description and a
  // long conversation both re-parse their whole markdown on every return to the tab.
  // `visibility` keeps boxes, sizes and scroll offsets, and takes hidden content out of the tab
  // order and the accessibility tree.
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<DetailTab>>(
    () => new Set<DetailTab>(["summary"]),
  );
  useEffect(() => {
    setMountedTabs((previous) =>
      previous.has(tab) ? previous : new Set<DetailTab>(previous).add(tab),
    );
  }, [tab]);
  const [chromeCondensed, setChromeCondensed] = useState(false);
  // Each tab remembers whether its chrome was condensed. Only the active tab can emit scroll
  // events, so the capture handler always writes the active tab's entry — and a tab switch
  // reads the destination's memory instead of inheriting the tab being left. A tab too short
  // to scroll remembers "expanded", which is what keeps it from being stranded under a chrome
  // it has no scrollbar to reopen.
  const chromeStateByTab = useRef<Partial<Record<DetailTab, boolean>>>({});
  useEffect(() => {
    setChromeCondensed(chromeStateByTab.current[tab] ?? false);
  }, [tab]);
  const condensed = chromeVariant === "collapse" && chromeCondensed;
  // Collapsing removes the fold's height from the chrome, which would otherwise hand that
  // height to the scrollport and leap the content up by it mid-scroll. The cure is exact
  // compensation: collapse only once the reader has scrolled at least the fold's height,
  // then give that height back to `scrollTop` before the next paint — the content under
  // their eyes does not move, and the collapse itself is the only thing that changes.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  // The condensed chrome's second row opens as the fold closes, so the height the scrollport
  // gains is the fold's minus this row's. Measured the same way the fold is: `scrollHeight`
  // through a zero track reads its natural height in either state.
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (compensationRef.current === null) return;
    const scroller = scrollerRef.current;
    const delta = compensationRef.current;
    compensationRef.current = null;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [condensed]);
  const [confirmClose, setConfirmClose] = useState<{ reason: IssueCloseReason | null } | null>(
    null,
  );
  const [actionPending, setActionPending] = useState(false);
  /** Which hand-off is under way, so only the item that was pressed says it is working. */
  const [handoff, setHandoff] = useState<string | null>(null);

  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  // Read apart from the detail so an issue with two hundred comments still shows its title,
  // its state and its actions while the conversation is still on its way.
  const activityQuery = useEnvironmentQuery(
    issueEnvironment.activity({ environmentId, input: reference }),
  );
  const coreDetail = detailQuery.data;
  const activity = activityQuery.data;
  const detail = useMemo(
    () =>
      coreDetail === null
        ? null
        : {
            ...coreDetail,
            author: activity?.author ?? coreDetail.author,
            comments: activity?.comments ?? [],
            // The host's own count, which the core read already carries: the conversation being
            // unread is not the same as there being nothing in it.
            commentCount: activity?.commentCount ?? coreDetail.commentCount,
            commentsTruncated: activity?.commentsTruncated ?? false,
            events: activity?.events ?? [],
          },
    [activity, coreDetail],
  );
  const activityPending = activityQuery.isPending && activity === null;
  const activityError = activity === null ? activityQuery.error : null;
  const refreshDetail = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
  }, [activityQuery.refresh, detailQuery.refresh]);
  useEffect(() => {
    if (!detail) return;
    onStateChange?.({
      projectId: detail.projectId,
      repository: detail.repository,
      number: detail.number,
      state: detail.state,
      stateReason: detail.stateReason,
    });
  }, [detail, onStateChange]);
  // An issue changes while it is open in front of somebody — a comment lands, someone closes it —
  // so the panel reads it again on the way back to the window and while a reader sits on it.
  // Keyed by the issue rather than by the panel, because this one panel shows a different issue
  // every time it is opened.
  useLiveRefresh(refreshDetail, {
    key: `issue:${reference.projectId}:${reference.repository}#${reference.number}`,
  });
  // The button, on the other hand, goes around the server's cache rather than through it: it is
  // the answer for a reader who can see that what they are looking at is behind. The
  // invalidation goes first so the re-reads miss that cache; if it fails, the reads still run
  // and at worst answer from it.
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const refreshFromHost = useCallback(async () => {
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
  }, [environmentId, invalidate, reference, refreshDetail]);
  // A refresh asked for by the page, rather than by the menu item below.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  const runAction = useAtomCommand(issueEnvironment.runAction, { reportFailure: false });
  const newThread = useNewThreadHandler();

  const perform = async (action: IssueAction, reason?: IssueCloseReason) => {
    if (actionPending) return;
    setActionPending(true);
    const result = await runAction({
      environmentId,
      input: { ...reference, action, ...(reason ? { reason } : {}) },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      // The host's own sentence, because it is the only thing that says why: a repository whose
      // tracker was switched off between opening this panel and pressing the button refuses with
      // a reason no page could have guessed.
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          ACTION_FAILURE_HINTS[action],
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    refreshDetail();
    onActed?.();
  };

  /**
   * The composer a hand-off writes into without opening anything, or null where it has to open a
   * thread first.
   *
   * A thread standing in another project is not that composer: writing "solve this issue" into a
   * conversation whose working tree is a different repository hands the agent a task it cannot do
   * where it is, so the issue's own project gets a thread instead.
   */
  const inPlaceDraft =
    handoffTarget.kind === "existing-thread" &&
    handoffTarget.projectRef.environmentId === environmentId &&
    handoffTarget.projectRef.projectId === detail?.projectId
      ? handoffTarget.draftId
      : null;

  const writeHandoff = (target: ScopedThreadRef | DraftId, task: IssueHandoff) => {
    const store = useComposerDraftStore.getState();
    // The latest press is the ask: it takes over what an earlier hand-off left, prompt and chips
    // both, rather than stacking a second one under the first. What the reader typed themselves
    // survives — the composer they are handed is not always a fresh one, and a prompt they have
    // since edited is theirs rather than the hand-off's.
    const draft = store.getComposerDraft(target);
    const key = draftKey(target);
    const prompt = handoffPrompt(
      { prompt: draft?.prompt ?? "", lastHandoffPrompt: lastHandoffPromptByDraft.get(key) },
      task.prompt,
    );
    // Remember the hand-off's own contribution, not the merged prompt: only that sentence is
    // this panel's to take back next time, and the reader's text around it is not.
    lastHandoffPromptByDraft.set(key, task.prompt);
    store.setPrompt(target, prompt);
    store.setReviewComments(
      target,
      issueHandoffReviewComments(draft?.reviewComments ?? [], task.reviewComments),
    );
  };

  /**
   * Hands the issue over as a task in a composer, and leaves it there to be read before it is
   * sent. Nothing is checked out and no code is touched: an issue is a description of work, not
   * the work, and which branch to do it on is the thread's question rather than this panel's.
   */
  const startHandoff = async (
    kind: string,
    build: (source: IssueHandoffSource) => IssueHandoff,
  ) => {
    if (!detail || handoff !== null) return;
    const task = build({
      number: detail.number,
      repository: detail.repository,
      title: detail.title,
      url: detail.url,
      body: detail.body,
      comments: detail.comments,
    });
    // "Ask" and "Add to composer" leave the composer empty on purpose, so saying the question is
    // in it would send the reader looking for something that is not there. The chips are what
    // landed.
    const description =
      task.prompt.length > 0
        ? "The task is in the composer — read it over, then send."
        : "The issue is in the composer — type your message, then send.";
    if (inPlaceDraft !== null) {
      writeHandoff(inPlaceDraft, task);
      toastManager.add({ type: "success", title: "Added to this thread", description });
      return;
    }
    setHandoff(kind);
    const opened = await newThread(scopeProjectRef(environmentId, detail.projectId)).then(
      (session) => session,
      () => null,
    );
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    writeHandoff(opened.draftId, task);
    toastManager.add({ type: "success", title: "Opened in a thread", description });
  };

  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  // Two questions, both of which have to say yes: whether this host can do it at all, and
  // whether this account may. A reader with read access on someone else's project sees the issue
  // and none of the buttons that would only ever be refused.
  const can = (action: IssueAction) =>
    detail?.capabilities.actions.includes(action) === true &&
    detail.viewerPermissions.actions.includes(action);
  const canEdit = detail?.capabilities.edit === true && detail.viewerPermissions.edit;
  // A host that takes labels but will not say which a repository has has nothing to open a picker
  // on, so the menu item that opens one goes with it.
  const canLabel =
    detail?.capabilities.labels === true &&
    detail.capabilities.listLabelCandidates &&
    detail.viewerPermissions.labels;
  const canAssign =
    detail?.capabilities.assignees === true &&
    detail.capabilities.listAssigneeCandidates &&
    detail.viewerPermissions.assignees;
  const closeReasons = detail?.capabilities.closeReasons ?? [];
  const statePresentation = detail
    ? resolveIssueState({ state: detail.state, stateReason: detail.stateReason })
    : null;
  // The pickers live in the summary's meta row, so the menu items that open them bring the reader
  // to the tab holding them first: a popup anchored to a hidden row opens nowhere.
  const openPickerOnSummary = (picker: "labels" | "assignees") => {
    setTab("summary");
    setOpenPicker(picker);
  };
  const handoffLabel = (kind: string, label: string) => (handoff === kind ? "Opening..." : label);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* The top row's geometry never changes: both of its states occupy the same stacked
          cell and crossfade, so the actions on the right have one home whatever the chrome
          is doing below. The fold and this fade share one 200ms clock. */}
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        {/* The fixed height lives on the two top-row cells — not the grid, whose later rows
            are the fold — so the actions have one immovable home in both states. */}
        <div className="ml-4 grid h-11 min-w-0 items-center">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-opacity sm:text-xs motion-reduce:transition-none",
              // Sequenced, not simultaneous: the leaving layer clears quickly before the
              // arriving one lands, so no frame shows both texts superimposed at half opacity.
              condensed
                ? "pointer-events-none opacity-0 duration-100"
                : "opacity-100 delay-75 duration-150",
            )}
          >
            {detail && statePresentation ? (
              <>
                <span className="min-w-0 truncate" title={detail.repository}>
                  {detail.repository}
                </span>
                <button
                  type="button"
                  onClick={() => openOnHost(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open issue #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
              </>
            ) : null}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-sm transition-opacity sm:text-xs motion-reduce:transition-none",
              condensed
                ? "opacity-100 delay-75 duration-150"
                : "pointer-events-none opacity-0 duration-100",
            )}
          >
            {detail && statePresentation ? (
              <>
                <button
                  type="button"
                  tabIndex={condensed ? 0 : -1}
                  onClick={() => openOnHost(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open issue #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
                <span className="min-w-0 truncate font-medium text-foreground" title={detail.title}>
                  {detail.title}
                </span>
                <statePresentation.Icon
                  role="img"
                  aria-label={statePresentation.label}
                  className={cn("size-3.5 shrink-0", statePresentation.toneClassName)}
                />
              </>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-11 min-w-0 flex-nowrap items-center justify-end gap-1">
          {detail ? (
            <>
              <Menu>
                <MenuTrigger
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="More issue actions"
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-72">
                  <MenuItem disabled={detailQuery.isPending} onClick={() => void refreshFromHost()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </MenuItem>
                  {/* Only where the button row could not take it: on a page "Solve" is the header
                      button, so offering it here as well would show the same action twice. */}
                  {context === "thread" ? (
                    <MenuItem
                      disabled={handoff !== null}
                      onClick={() => void startHandoff("solve", buildSolveIssueHandoff)}
                    >
                      <HammerIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>{handoffLabel("solve", "Solve this issue")}</span>
                        <span className="text-xs text-muted-foreground">
                          {inPlaceDraft === null
                            ? "Opens a thread on this project holding the task."
                            : "Puts the task in this thread's composer."}
                        </span>
                      </span>
                    </MenuItem>
                  ) : null}
                  <MenuItem
                    disabled={handoff !== null}
                    onClick={() => void startHandoff("ask", buildAskAboutIssueHandoff)}
                  >
                    <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoffLabel("ask", "Ask a question")}</span>
                      <span className="text-xs text-muted-foreground">
                        Leaves the issue in the composer for a question of your own.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem
                    disabled={handoff !== null}
                    onClick={() => void startHandoff("explain", buildExplainIssueHandoff)}
                  >
                    <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoffLabel("explain", "Explain this issue")}</span>
                      <span className="text-xs text-muted-foreground">
                        A read of what is being asked for, and what it concerns here.
                      </span>
                    </span>
                  </MenuItem>
                  {/* Only where there is a conversation to add it to: everything else here opens
                      one, and "add to the thread you are in" would be that same thread. */}
                  {inPlaceDraft === null ? null : (
                    <MenuItem
                      disabled={handoff !== null}
                      onClick={() => void startHandoff("attach", buildAttachIssueContext)}
                    >
                      <PaperclipIcon className="size-3.5" />
                      Add to composer
                    </MenuItem>
                  )}
                  {canEdit || canLabel || canAssign ? (
                    <>
                      <MenuSeparator />
                      {canEdit ? (
                        <MenuItem
                          onClick={() => {
                            setTab("summary");
                            setEditing(true);
                          }}
                        >
                          <PencilLineIcon className="size-3.5" />
                          Edit title and description
                        </MenuItem>
                      ) : null}
                      {canLabel ? (
                        <MenuItem onClick={() => openPickerOnSummary("labels")}>
                          <TagIcon className="size-3.5" />
                          Labels
                        </MenuItem>
                      ) : null}
                      {canAssign ? (
                        <MenuItem onClick={() => openPickerOnSummary("assignees")}>
                          <UserPlusIcon className="size-3.5" />
                          Assignees
                        </MenuItem>
                      ) : null}
                    </>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem onClick={() => openOnHost(detail.url)}>
                    <ArrowUpRightIcon className="size-3.5" />
                    {OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  </MenuItem>
                  <MenuItem onClick={() => void writeTextToClipboard(detail.url)}>
                    <LinkIcon className="size-3.5" />
                    Copy link
                  </MenuItem>
                </MenuPopup>
              </Menu>
              {/* Handing the issue to an agent is the reason to open one here at all, so on a page
                  it is a button of its own rather than a line in a menu. */}
              {context === "page" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={handoff !== null}
                  onClick={() => void startHandoff("solve", buildSolveIssueHandoff)}
                >
                  {handoff === "solve" ? (
                    "Opening..."
                  ) : (
                    <>
                      <HammerIcon className="size-3" />
                      Solve
                    </>
                  )}
                </Button>
              ) : null}
              {detail.state === "open" && can("close") ? (
                closeReasons.length > 0 ? (
                  // A reason is not a second action but a part of this one, so it is chosen on the
                  // way rather than offered as another button.
                  <Menu>
                    <MenuTrigger
                      disabled={actionPending}
                      render={
                        <Button size="xs">
                          {actionPending ? (
                            "Closing..."
                          ) : (
                            <>
                              Close
                              <ChevronDownIcon className="size-3 opacity-80" />
                            </>
                          )}
                        </Button>
                      }
                    />
                    <MenuPopup align="end" side="bottom" className="min-w-56">
                      {closeReasons.map((reason) => (
                        <MenuItem
                          key={reason}
                          disabled={actionPending}
                          onClick={() => setConfirmClose({ reason })}
                        >
                          {CLOSE_REASON_LABELS[reason]}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : (
                  <Button
                    size="xs"
                    disabled={actionPending}
                    onClick={() => setConfirmClose({ reason: null })}
                  >
                    {actionPending ? "Closing..." : "Close"}
                  </Button>
                )
              ) : detail.state === "closed" && can("reopen") ? (
                <Button size="xs" disabled={actionPending} onClick={() => void perform("reopen")}>
                  {actionPending ? "Reopening..." : "Reopen"}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>

        {/* The condensed chrome's second row: the tabs that the closing fold takes with it, and a
            compact copy of the state so it stays in sight while the full rows are folded away.
            Same zero-track mechanism as the fold, inverted. */}
        <div className={cn("col-span-2 grid", condensed ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none"
                : "opacity-0",
            )}
            inert={!condensed}
          >
            {detail && statePresentation ? (
              <div className="flex min-w-0 items-center gap-1 px-4 pb-2">
                <nav aria-label="Issue tabs" className="flex shrink-0 items-center gap-0.5">
                  {TABS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      tabIndex={condensed ? 0 : -1}
                      aria-pressed={tab === item.value}
                      onClick={() => setTab(item.value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] transition-colors",
                        tab === item.value
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
                <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
                  {statePresentation.label} · updated {formatRelativeTimeLabel(detail.updatedAt)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Folding is a grid track going to zero: the rows below stay mounted, the track
            animates closed over them, and `inert` takes the hidden controls out of the tab
            order for as long as the chrome is condensed. */}
        <div
          className={cn(
            "col-span-2 grid",
            // Instant in both directions: the scroll compensation keeps the content pinned
            // through either flip, and an animated track would fight it frame by frame. The
            // top row's crossfade is the transition.
            condensed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
          )}
        >
          <div
            ref={foldRef}
            // One-way on purpose: appearing content eases in over ground the instant track
            // already reserved; departing content cuts, because its ground is gone in the
            // same frame and the scroll compensation reads it as scrolled past.
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-0"
                : "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none",
            )}
            inert={condensed}
          >
            {detail && statePresentation ? (
              <div className="col-span-2 mt-3 min-w-0 px-4 pb-4">
                <h1 className="text-base font-semibold leading-snug">{detail.title}</h1>
                <SourceControlMetaLine className="mt-2 text-xs text-muted-foreground">
                  <Badge
                    variant="outline"
                    className={cn("h-5 gap-1 rounded px-1.5", statePresentation.toneClassName)}
                  >
                    <statePresentation.Icon aria-hidden className="size-3" />
                    {statePresentation.label}
                  </Badge>
                  <SourceControlActorLabel actor={detail.author} className="font-medium" />
                  <span>updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
                </SourceControlMetaLine>
              </div>
            ) : null}

            {detail ? (
              <nav
                className="col-span-2 flex min-w-0 items-center gap-1 overflow-x-auto border-t border-border/60 px-4 py-2"
                aria-label="Issue tabs"
              >
                {TABS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={tab === item.value}
                    onClick={() => setTab(item.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
                      tab === item.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
                {tab === "timeline" ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 whitespace-nowrap text-[11px] transition-opacity",
                        (activityPending || activityError) && "opacity-35",
                      )}
                      aria-label={
                        activityError
                          ? "Comments unavailable"
                          : `${detail.commentCount.toLocaleString()} ${
                              detail.commentCount === 1 ? "comment" : "comments"
                            }`
                      }
                    >
                      <MessageSquareIcon aria-hidden className="size-3" />
                      {activityError
                        ? "—"
                        : activityPending
                          ? "…"
                          : detail.commentCount.toLocaleString()}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-7 px-2 text-[10px] text-muted-foreground"
                      aria-label={
                        timelineOrder === "oldest"
                          ? "Show newest activity first"
                          : "Show oldest activity first"
                      }
                      onClick={() =>
                        setTimelineOrder((value) => (value === "oldest" ? "newest" : "oldest"))
                      }
                    >
                      <ArrowDownUpIcon aria-hidden className="size-3" />
                      {timelineOrder === "oldest" ? "Oldest first" : "Newest first"}
                    </Button>
                  </div>
                ) : null}
              </nav>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        // Scroll does not bubble, but it captures: one listener hears every tab's own scroll
        // container. Collapse past two line-heights, expand only back at the very top, so the
        // boundary row cannot flap the chrome open and shut.
        onScrollCapture={(event) => {
          if (chromeVariant !== "collapse") return;
          const scroller = event.target as HTMLElement;
          scrollerRef.current = scroller;
          const top = scroller.scrollTop;
          setChromeCondensed((previous) => {
            let next = previous;
            // `scrollHeight` reads the fold's natural height whichever state the track is in.
            const foldHeight = foldRef.current?.scrollHeight ?? 0;
            // The chrome trades the fold for the condensed second row, so the height the
            // scrollport actually gains is the difference between the two.
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            if (previous) {
              // The hard top reopens the chrome. The refund puts the reader a fold's height
              // from the top, pinned to the same pixels — the metadata is scrolled up to,
              // not thrown at them.
              if (top < 4 && foldHeight > 0) {
                compensationRef.current = chromeDelta;
                next = false;
              }
            } else if (foldHeight > 0 && top > foldHeight + 32) {
              compensationRef.current = -chromeDelta;
              next = true;
            }
            chromeStateByTab.current[tab] = next;
            return next;
          });
        }}
      >
        {detailQuery.isPending && !detail ? (
          // The ghost wears the shape of the tab being waited on, so switching tabs mid-load
          // does not flash a summary outline under a timeline heading.
          tab === "timeline" ? (
            <IssueTimelineGhost />
          ) : (
            <IssueDetailGhost />
          )
        ) : detailQuery.error && !detail ? (
          <IssuesUnavailableState error={detailQuery.error} onRetry={refreshDetail} />
        ) : detail ? (
          <>
            {mountedTabs.has("summary") ? (
              <div className={cn("absolute inset-0", tab !== "summary" && "invisible")}>
                <IssueSummaryTab
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  activityError={activityError}
                  editing={editing}
                  onEditingChange={setEditing}
                  openPicker={openPicker}
                  onOpenPickerChange={setOpenPicker}
                  onOpenLinkedPullRequest={(link) =>
                    onOpenLinkedPullRequest === undefined
                      ? openOnHost(link.url)
                      : onOpenLinkedPullRequest(link)
                  }
                  onRefresh={refreshDetail}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div className={cn("absolute inset-0", tab !== "timeline" && "invisible")}>
                {activityPending ? (
                  <IssueTimelineGhost />
                ) : activityError ? (
                  <IssueActivityUnavailableState
                    error={activityError}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <IssueTimelineTab detail={detail} order={timelineOrder} />
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <AlertDialog
        open={confirmClose !== null}
        onOpenChange={(open) => !open && setConfirmClose(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close issue?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This closes #${reference.number}${
                confirmClose?.reason ? CLOSE_REASON_PHRASES[confirmClose.reason] : ""
              } on the host. You can reopen it afterwards.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={actionPending}
              onClick={() => {
                const reason = confirmClose?.reason ?? undefined;
                setConfirmClose(null);
                void perform("close", reason);
              }}
            >
              Close issue
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
