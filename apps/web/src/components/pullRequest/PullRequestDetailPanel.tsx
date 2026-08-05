import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  MessageCircleQuestionIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RefreshCwIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { useEnvironmentQuery } from "~/state/query";
import { useRefreshOnFocus } from "~/hooks/useRefreshOnFocus";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import type { PullRequestAskSelectionInput } from "./PullRequestCodeTab";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import {
  buildAskAboutLinesHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  pullRequestFindingKey,
  readableFailure,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import { PullRequestStateGlyph } from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code";

const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
const ACTION_FAILURE_LABELS: Record<PullRequestAction, string> = {
  merge: "Could not merge this pull request",
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: "Could not close this pull request",
  reopen: "Could not reopen this pull request",
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<PullRequestAction, string> = {
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
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
  { value: "code", label: "Code" },
];

// The diff viewer pulls in its worker pool, so it stays out of the bundle until Code is opened.
const PullRequestCodeTab = lazy(() => import("./PullRequestCodeTab"));

export function PullRequestDetailPanel({
  environmentId,
  reference,
  onClose,
  context = "page",
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** Absent when something around the panel already owns closing it — a surface tab's own X. */
  onClose?: () => void;
  /**
   * Beside a thread, the checkout affordance disappears: the panel is showing that thread's
   * own pull request, so the branch is already under the reader's feet — and checking it out
   * again is at best a no-op and at worst git refusing a branch two checkouts.
   */
  context?: "page" | "thread";
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  const [codeMounted, setCodeMounted] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  // Which handoff is preparing, keyed so a per-finding button can say "Preparing..." on itself
  // alone. One at a time whatever the key: they all check the same pull request out.
  const [handoff, setHandoff] = useState<string | null>(null);

  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data;
  // A pull request changes while it is open in front of somebody — a push lands, a check
  // finishes, a review arrives — so coming back to the window reads it again. This read goes
  // through the server's cache rather than around it: freshness bounded by the cache window,
  // at no extra cost to the host.
  useRefreshOnFocus(() => detailQuery.refresh());
  // Refreshing is a button, not a poll or a focus listener: every read here shells out to the
  // host's API from the server, so only a person should be able to spend those requests. The
  // invalidation goes first so the re-reads miss the server's cache; if it fails, the reads
  // still run and at worst answer from that cache.
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshFromHost = async () => {
    await invalidate({ environmentId, input: { reference } });
    detailQuery.refresh();
    setRefreshToken((token) => token + 1);
  };
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [actionPending, setActionPending] = useState(false);
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionPending) return;
    setActionPending(true);
    const result = await runAction({
      environmentId,
      input: { ...reference, action, ...(method ? { mergeMethod: method } : {}) },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      // The host's own sentence, because it is the only thing that says why. A merge strategy a
      // branch policy forbids is refused at completion and nowhere earlier — Azure DevOps
      // publishes no per-strategy availability to hide the control with — so "action failed"
      // would leave the reader pressing the same button again.
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(failure, ACTION_FAILURE_HINTS[action]),
      });
      return;
    }
    toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    detailQuery.refresh();
  };

  type ThreadTask = {
    prompt: string;
    reviewComments?: ReadonlyArray<ReviewCommentContext>;
  };

  /**
   * Opens a thread on this project and leaves the task in its composer for the reader to send.
   *
   * Nothing is checked out: asking a question is not a reason to move somebody's working tree or
   * to make a worktree they did not ask for. The two hand-offs that do need the code call this
   * after preparing it, so there is one path from "a task" to "a thread holding it".
   */
  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: ThreadTask | null,
    opened?: { draftId: DraftId },
  ): Promise<{ draftId: DraftId } | null> => {
    const session =
      opened ??
      (await newThread(projectRef).then(
        (result) => result,
        () => null,
      ));
    if (session === null) return null;
    const store = useComposerDraftStore.getState();
    if (task === null) return session;
    // Appended rather than assigned: the composer may already hold something the user typed,
    // and losing it would be worse than a prompt they have to scroll.
    const existing = store.getComposerDraft(session.draftId)?.prompt ?? "";
    store.setPrompt(
      session.draftId,
      existing.trim().length === 0 ? task.prompt : `${existing}\n\n${task.prompt}`,
    );
    for (const comment of task.reviewComments ?? []) {
      store.addReviewComment(session.draftId, comment);
    }
    return session;
  };

  /** A question about the change, which needs a thread and nothing else. */
  const startAsk = async (kind: string, task: ThreadTask) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Asked in a thread",
      description: "The question is in the composer — read it over, then send.",
    });
  };

  // Every handoff works the same way: check the pull request out into its own worktree, open a
  // thread there, and — when it carries a task — put that in the composer for the user to read
  // before sending. Checking out is the whole point of the ones that carry nothing.
  const startHandoff = async (
    kind: string,
    task: { prompt: string; reviewComments?: ReadonlyArray<ReviewCommentContext> } | null,
    // A worktree leaves whatever is open alone, which is why it is the default. Checking out in
    // the repository itself is what you want when the point is to run the thing where you
    // already work — and it moves the branch under everything else that is open there.
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // The menu closes on the press and takes its "Preparing..." label with it, so this is the
    // only thing answering for the checkout. It carries no timeout of its own: a loading toast
    // never expires, and an explicit one would survive the update and pin the result on screen.
    const toastId = toastManager.add({
      type: "loading",
      title: "Preparing the pull request checkout...",
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // The thread is opened before the checkout rather than after it, because the project's setup
    // script only runs for a checkout that knows which thread it is for — and a worktree with no
    // dependencies installed is not something anyone can test.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (opened === null) {
      setHandoff(null);
      // Without a thread there is nowhere for the checkout to belong: its setup script would not
      // run and its task would have no composer to land in. Better to stop before touching the
      // working tree than to prepare a worktree nobody asked for.
      toastManager.update(toastId, {
        type: "error",
        title: "Could not open a thread for the checkout",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      // The server says what to do about it — that the branch is already checked out in the main
      // repository, say — and that sentence is the only way out of the failure.
      const detailMessage =
        prepareThread.error instanceof Error ? prepareThread.error.message : null;
      toastManager.update(toastId, {
        type: "error",
        title: "Could not prepare the pull request checkout",
        ...(detailMessage ? { description: detailMessage } : {}),
      });
      return;
    }
    // The same thread again, now that there is somewhere to point it at. A local checkout has
    // no worktree of its own, so the thread runs where the repository already is.
    const pointed = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: prepared.value.worktreePath === null ? "local" : "worktree",
    }).then(
      () => true,
      () => false,
    );
    if (!pointed) {
      setHandoff(null);
      // The checkout is on disk; only the thread failed to move onto it. Writing the task now
      // would send the agent at whatever the thread was already open on — which is the one
      // outcome worth stopping for, since it reads as success and is not.
      toastManager.update(toastId, {
        type: "error",
        title: "Checked out, but the thread stayed where it was",
        description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return;
    }
    // Released here whatever happened next: a loading toast never expires on its own, so leaving
    // this set would spin forever and lock every handoff behind it until a reload.
    setHandoff(null);
    // A worktree that was already there and had been worked in keeps whatever it holds, so the
    // thread opens on older code than the pull request carries. Said once, in place of the
    // success, because everything else about the handoff did happen.
    const staleCheckoutToast = {
      type: "warning",
      title: "Checked out, but not on the latest commits",
      description:
        "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
    } as const;
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: mode === "local" ? "Checked out here" : "Checked out",
              description:
                mode === "local"
                  ? "This repository is on the pull request's branch, with a thread open on it."
                  : "The pull request is in its own worktree, with a thread open on it.",
            }
          : staleCheckoutToast,
      );
      return;
    }
    await openThreadWithTask(projectRef, task, opened);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: "Checkout ready",
            description: "The task is in the composer — read it over, then send.",
          }
        : staleCheckoutToast,
    );
  };

  const askAboutPullRequest = () => {
    if (!detail) return;
    void startAsk("ask", {
      ...buildAskAboutPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const explainPullRequest = () => {
    if (!detail) return;
    void startAsk("explain", {
      ...buildExplainPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  /** Lines the reader marked in the diff, asked about rather than commented on. */
  const askAboutSelection = (selection: PullRequestAskSelectionInput) => {
    if (!detail) return;
    void startAsk(`ask:${selection.comment.id}`, {
      ...buildAskAboutLinesHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        comment: selection.comment,
        question: selection.question,
      }),
    });
  };

  const startCheckout = (mode: "worktree" | "local") => {
    if (!detail) return;
    void startHandoff(`checkout:${mode}`, null, mode);
  };

  /** One finding, handed over on its own — the surfaces that show findings call this. */
  const startFixFinding = (finding: PullRequestFinding) => {
    if (!detail) return;
    void startHandoff(
      pullRequestFindingKey(finding),
      buildFixFindingHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        finding,
      }),
    );
  };

  const startFixFindings = () => {
    if (!detail) return;
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: detail.reviewThreads,
        comments: detail.comments,
        checks: detail.checks,
        commentsTruncated: detail.commentsTruncated,
      }),
    );
  };

  const startResolveConflicts = () => {
    if (!detail) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: detail.number,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  // The host says which strategies it offers at all; the repository narrows that to the ones
  // it actually allows.
  const allowedMergeMethods = detail
    ? detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method])
    : [];
  const selectedMergeMethod = allowedMergeMethods.includes(mergeMethod)
    ? mergeMethod
    : (allowedMergeMethods[0] ?? "merge");
  const conflicting = detail?.state === "open" && detail.mergeability === "conflicting";
  // A host that cannot produce a patch has no Code tab to open. Until the detail arrives the
  // full set is shown, so the row does not shift once it does.
  const visibleTabs = TABS.filter(
    (item) => item.value !== "code" || detail === null || detail.capabilities.diff,
  );
  // The Code tab can be opened while the detail is still on its way, and the detail may then say
  // this host has no patch to show. The tab goes, so whoever was standing on it is moved back to
  // the summary rather than left looking at a panel that is no longer reachable.
  useEffect(() => {
    if (!visibleTabs.some((item) => item.value === tab)) setTab("summary");
  }, [tab, visibleTabs]);
  // Two questions, both of which have to say yes: whether this host can do it at all, and
  // whether this account may. A reader with read access on someone else's project sees the pull
  // request and none of the buttons that would only ever be refused.
  const can = (action: PullRequestAction) =>
    detail?.capabilities.actions.includes(action) === true &&
    detail.viewerPermissions.actions.includes(action);
  // One live action holds the slot. A conflicting change cannot be merged now, so the slot goes
  // to the thing that would help instead of a Merge button that only ever says no.
  const primaryAction =
    detail === null || detail.state !== "open"
      ? null
      : detail.isDraft && can("ready")
        ? "ready"
        : !can("merge")
          ? null
          : conflicting
            ? "resolve"
            : allowedMergeMethods.length > 0
              ? "merge"
              : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="surface-subheader gap-2 px-3" data-surface-subheader>
        {detail ? (
          <PullRequestStateGlyph
            state={detail.state}
            isDraft={detail.isDraft}
            mergeability={detail.mergeability}
            baseBranch={detail.baseBranch}
          />
        ) : null}
        <nav className="flex min-w-0 items-center gap-0.5" aria-label="Pull request tabs">
          {visibleTabs.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => {
                // Once opened, the diff viewer is kept alive for the rest of the panel's life.
                if (item.value === "code") setCodeMounted(true);
                setTab(item.value);
              }}
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                tab === item.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail ? (
            <>
              <Menu>
                <MenuTrigger
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="More pull request actions"
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-52">
                  <MenuItem disabled={detailQuery.isPending} onClick={() => void refreshFromHost()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </MenuItem>
                  <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
                    <ExternalLinkIcon className="size-3.5" />
                    {OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  </MenuItem>
                  <MenuSeparator />
                  {detail.state === "open" ? (
                    <>
                      {can(detail.isDraft ? "ready" : "draft") ? (
                        <MenuItem
                          disabled={actionPending}
                          onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
                        >
                          {detail.isDraft ? (
                            <GitPullRequestIcon className="size-3.5" />
                          ) : (
                            <GitPullRequestDraftIcon className="size-3.5" />
                          )}
                          {detail.isDraft ? "Ready for review" : "Convert to draft"}
                        </MenuItem>
                      ) : null}
                      {/* A preference for the merge action rather than a second action, so it
                          is a radio group here instead of a chevron welded to the Merge pill.
                          Hidden while conflicting: every method would fail. */}
                      {/* Only where merging is on offer at all: a strategy to merge with is not
                          a choice for someone who may not merge. */}
                      {can("merge") &&
                      !detail.isDraft &&
                      !conflicting &&
                      allowedMergeMethods.length > 1 ? (
                        <>
                          <MenuSeparator />
                          <MenuRadioGroup
                            value={selectedMergeMethod}
                            onValueChange={(method) =>
                              setMergeMethod(method as PullRequestMergeMethod)
                            }
                          >
                            {allowedMergeMethods.map((method) => (
                              <MenuRadioItem key={method} value={method} disabled={actionPending}>
                                {/* The radio item lays its children out as one block, so the
                                    icon and the label need their own row to share a line. */}
                                <span className="flex min-w-0 items-center gap-2">
                                  <GitMergeIcon className="size-3.5" />
                                  <span className="capitalize">{method}</span>
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </>
                      ) : null}
                      <MenuSeparator />
                    </>
                  ) : null}
                  <MenuItem onClick={() => void writeTextToClipboard(detail.url)}>
                    <LinkIcon className="size-3.5" />
                    Copy link
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={startFixFindings}>
                    <HammerIcon className="size-3.5" />
                    {handoff === "findings" ? "Preparing..." : "Fix findings in a thread"}
                  </MenuItem>
                  {/* Only where the button row could not take it, so it is never offered twice. */}
                  {conflicting && primaryAction !== "resolve" ? (
                    <MenuItem disabled={handoff !== null} onClick={startResolveConflicts}>
                      <GitMergeIcon className="size-3.5" />
                      {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts in a thread"}
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" && can("close") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={actionPending}
                        onClick={() => setConfirmAction("close")}
                      >
                        <GitPullRequestClosedIcon className="size-3.5" />
                        Close pull request
                      </MenuItem>
                    </>
                  ) : detail.state === "closed" && can("reopen") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
                        <GitPullRequestIcon className="size-3.5" />
                        Reopen pull request
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
              {/* Checking a pull request out is the reason to open one here at all, so it is a
                  button of its own rather than a side effect of asking an agent for something.
                  It asks where, because the two answers are not interchangeable: one leaves your
                  work where it is, the other moves the repository you are standing in. Only on
                  the page: beside a thread the branch is already checked out right there. */}
              {context === "page" ? (
                <Menu>
                  <MenuTrigger
                    disabled={handoff !== null}
                    render={
                      <Button size="xs" variant="outline">
                        {handoff?.startsWith("checkout") ? (
                          "Checking out..."
                        ) : (
                          <>
                            <GitBranchIcon className="size-3" />
                            Check out
                            <ChevronDownIcon className="size-3 text-muted-foreground" />
                          </>
                        )}
                      </Button>
                    }
                  />
                  <MenuPopup align="end" side="bottom" className="min-w-72">
                    <MenuItem onClick={() => startCheckout("worktree")}>
                      <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In a separate worktree</span>
                        <span className="text-xs text-muted-foreground">
                          Its own folder and thread. Nothing you have open moves.
                        </span>
                      </span>
                    </MenuItem>
                    <MenuItem onClick={() => startCheckout("local")}>
                      <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In this repository</span>
                        <span className="text-xs text-muted-foreground">
                          Switches the branch you are working in, like `gh pr checkout`.
                        </span>
                      </span>
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
              {/* Beside checking out, because they are the two things somebody opening a pull
                  request wants: the code, or an answer about it. Asking takes no checkout — a
                  question is not a reason to move the working tree or to make a worktree nobody
                  asked for — which is what keeps it a separate press rather than a mode of the
                  one next to it. */}
              <Menu>
                <MenuTrigger
                  disabled={handoff !== null}
                  render={
                    <Button size="xs" variant="outline">
                      {handoff === "ask" || handoff === "explain" ? (
                        "Opening..."
                      ) : (
                        <>
                          <MessageCircleQuestionIcon className="size-3" />
                          Ask
                          <ChevronDownIcon className="size-3 text-muted-foreground" />
                        </>
                      )}
                    </Button>
                  }
                />
                <MenuPopup align="end" side="bottom" className="min-w-72">
                  <MenuItem onClick={askAboutPullRequest}>
                    <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>Ask a question</span>
                      <span className="text-xs text-muted-foreground">
                        Opens a thread that knows which pull request you mean.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem onClick={explainPullRequest}>
                    <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>Explain this PR</span>
                      <span className="text-xs text-muted-foreground">
                        A walk through the diff: what it is for, and what to read closely.
                      </span>
                    </span>
                  </MenuItem>
                </MenuPopup>
              </Menu>
              {primaryAction === "ready" ? (
                <Button size="xs" disabled={actionPending} onClick={() => void perform("ready")}>
                  Ready for review
                </Button>
              ) : primaryAction === "resolve" ? (
                <Button size="xs" disabled={handoff !== null} onClick={startResolveConflicts}>
                  {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
                </Button>
              ) : primaryAction === "merge" ? (
                <Button
                  size="xs"
                  disabled={actionPending}
                  onClick={() => setConfirmAction("merge")}
                >
                  {actionPending ? "Merging..." : "Merge"}
                </Button>
              ) : null}
            </>
          ) : null}
          {onClose ? (
            // Panel chrome rather than an action: the same collapse glyph the rest of the app
            // uses for its right panel, ghosted so it does not compete with the buttons.
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse pull request panel"
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {detailQuery.isPending && !detail ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : detailQuery.error && !detail ? (
          <PullRequestsUnavailableState
            error={detailQuery.error}
            onRetry={() => detailQuery.refresh()}
          />
        ) : detail ? (
          <>
            {tab === "summary" ? (
              <PullRequestSummaryTab
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                pendingFinding={handoff}
                onFixFinding={startFixFinding}
                onRefresh={() => detailQuery.refresh()}
              />
            ) : tab === "timeline" ? (
              <PullRequestTimelineTab detail={detail} />
            ) : null}
            {/* Summary and Timeline are cheap enough to rebuild; the diff viewer is not, so it
                stays mounted behind them once opened. It virtualizes against its own scroll
                position and measures its host, both of which `display: none` would throw away —
                `visibility` keeps the box, its size and its scroll offset intact, and takes the
                content out of the tab order and the accessibility tree while it is hidden. */}
            {codeMounted ? (
              <div className={cn("absolute inset-0", tab !== "code" && "invisible")}>
                <Suspense fallback={<Skeleton className="m-5 h-48" />}>
                  <PullRequestCodeTab
                    onAskAboutSelection={askAboutSelection}
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    pendingFinding={handoff}
                    onFixFinding={startFixFinding}
                    onRefresh={() => detailQuery.refresh()}
                    refreshToken={refreshToken}
                  />
                </Suspense>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "merge" ? "Merge pull request?" : "Close pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "merge"
                ? `This merges #${reference.number} using ${selectedMergeMethod}.`
                : `This closes #${reference.number} without merging it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirmAction === "close" ? "destructive" : "default"}
              disabled={actionPending}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action === "merge") void perform("merge", selectedMergeMethod);
                if (action === "close") void perform("close");
              }}
            >
              {confirmAction === "merge" ? "Merge" : "Close"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
