import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  LinkIcon,
  MoreHorizontalIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { useEnvironmentQuery } from "~/state/query";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { buildFixFindingsHandoff, buildResolveConflictsPrompt } from "./pullRequestDetail.logic";
import { PullRequestStateGlyph } from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code";

const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
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
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  const [codeMounted, setCodeMounted] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  const [handoff, setHandoff] = useState<"findings" | "conflicts" | null>(null);

  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data;
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
      toastManager.add({ type: "error", title: "Pull request action failed" });
      return;
    }
    toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    detailQuery.refresh();
  };

  // Both handoffs work the same way: check the pull request out into its own worktree, open a
  // thread there, and put the task in its composer for the user to read before sending.
  const startHandoff = async (
    kind: "findings" | "conflicts",
    task: { prompt: string; reviewComments?: ReadonlyArray<ReviewCommentContext> },
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
    const prepared = await prepareThread.run({ reference: detail.url, mode: "worktree" });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: "Could not prepare the pull request checkout",
      });
      return;
    }
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: "worktree",
    }).then(
      () => true,
      () => false,
    );
    const store = useComposerDraftStore.getState();
    const draftId = opened
      ? (store.getDraftSessionByProjectRef(projectRef)?.draftId ?? null)
      : null;
    // Released here whatever happened next: a loading toast never expires on its own, so leaving
    // this set would spin forever and lock every handoff behind it until a reload.
    setHandoff(null);
    if (draftId === null) {
      // The checkout and the thread exist either way, so this reports only the part that did
      // not happen rather than presenting the whole handoff as failed.
      toastManager.update(toastId, {
        type: "error",
        title: "Checkout ready, but the task could not be written",
        description: "Describe the task in the composer to start.",
      });
      return;
    }
    // Appended rather than assigned: the composer may already hold something the user typed,
    // and losing it would be worse than a prompt they have to scroll.
    const existing = store.getComposerDraft(draftId)?.prompt ?? "";
    store.setPrompt(
      draftId,
      existing.trim().length === 0 ? task.prompt : `${existing}\n\n${task.prompt}`,
    );
    for (const comment of task.reviewComments ?? []) {
      store.addReviewComment(draftId, comment);
    }
    toastManager.update(toastId, {
      type: "success",
      title: "Checkout ready",
      description: "The task is in the composer — read it over, then send.",
    });
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
  const can = (action: PullRequestAction) => detail?.capabilities.actions.includes(action) === true;
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label="Open on GitHub"
                      onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                    />
                  }
                >
                  <ExternalLinkIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Open on GitHub</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="More pull request actions"
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-52">
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
                      {!detail.isDraft && !conflicting && allowedMergeMethods.length > 1 ? (
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
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Close pull request"
            onClick={onClose}
          >
            <XIcon className="size-3" />
          </Button>
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
                detail={detail}
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
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    onRefresh={() => detailQuery.refresh()}
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
