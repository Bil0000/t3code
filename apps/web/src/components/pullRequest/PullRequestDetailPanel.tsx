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

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
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
import { buildFixFindingsPrompt, buildResolveConflictsPrompt } from "./pullRequestDetail.logic";
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
  // thread there, and hand the user the task-specific prompt to review before sending.
  const startHandoff = async (kind: "findings" | "conflicts", prompt: string) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const prepared = await prepareThread.run({ reference: detail.url, mode: "worktree" });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.add({ type: "error", title: "Could not prepare the pull request checkout" });
      return;
    }
    await newThread(scopeProjectRef(environmentId, detail.projectId), {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: "worktree",
    });
    await writeTextToClipboard(prompt);
    setHandoff(null);
    toastManager.add({
      type: "success",
      title: "Checkout ready",
      description: "The prompt is on your clipboard — paste it to start.",
    });
  };

  const allowedMergeMethods = detail
    ? (["merge", "squash", "rebase"] as const).filter((method) => detail.mergeCapabilities[method])
    : [];
  const selectedMergeMethod = allowedMergeMethods.includes(mergeMethod)
    ? mergeMethod
    : (allowedMergeMethods[0] ?? "merge");
  const conflicting = detail?.state === "open" && detail.mergeability === "conflicting";

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="surface-subheader gap-2 px-3" data-surface-subheader>
        {detail ? (
          <PullRequestStateGlyph
            state={detail.state}
            isDraft={detail.isDraft}
            mergeability={detail.mergeability}
          />
        ) : null}
        <nav className="flex min-w-0 items-center gap-0.5" aria-label="Pull request tabs">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
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
                                <GitMergeIcon className="size-3.5" />
                                <span className="capitalize">{method}</span>
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
                  <MenuItem
                    disabled={handoff !== null}
                    onClick={() =>
                      void startHandoff(
                        "findings",
                        buildFixFindingsPrompt({
                          number: detail.number,
                          title: detail.title,
                          url: detail.url,
                          headBranch: detail.headBranch,
                          baseBranch: detail.baseBranch,
                          comments: detail.comments,
                          checks: detail.checks,
                          commentsTruncated: detail.commentsTruncated,
                        }),
                      )
                    }
                  >
                    <HammerIcon className="size-3.5" />
                    {handoff === "findings" ? "Preparing..." : "Fix findings in a thread"}
                  </MenuItem>
                  {conflicting ? (
                    <MenuItem
                      disabled={handoff !== null}
                      onClick={() =>
                        void startHandoff(
                          "conflicts",
                          buildResolveConflictsPrompt({
                            number: detail.number,
                            url: detail.url,
                            headBranch: detail.headBranch,
                            baseBranch: detail.baseBranch,
                          }),
                        )
                      }
                    >
                      <GitMergeIcon className="size-3.5" />
                      {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts in a thread"}
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" ? (
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
                  ) : detail.state === "closed" ? (
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
              {detail.state === "open" && detail.isDraft ? (
                <Button size="xs" disabled={actionPending} onClick={() => void perform("ready")}>
                  Ready for review
                </Button>
              ) : detail.state === "open" && conflicting ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button size="xs" aria-disabled className="cursor-not-allowed opacity-60" />
                    }
                  >
                    Merge
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Resolve merge conflicts before merging</TooltipPopup>
                </Tooltip>
              ) : detail.state === "open" && allowedMergeMethods.length > 0 ? (
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

      <div className="min-h-0 flex-1 overflow-hidden">
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
          tab === "summary" ? (
            <PullRequestSummaryTab
              environmentId={environmentId}
              detail={detail}
              onRefresh={() => detailQuery.refresh()}
            />
          ) : tab === "timeline" ? (
            <PullRequestTimelineTab detail={detail} />
          ) : (
            <Suspense fallback={<Skeleton className="m-5 h-48" />}>
              <PullRequestCodeTab environmentId={environmentId} reference={reference} />
            </Suspense>
          )
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
