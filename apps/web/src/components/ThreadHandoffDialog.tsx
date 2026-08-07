import type { ThreadHandoffProgress } from "@t3tools/client-runtime/state/threadHandoffTransfer";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { threadHandoff } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface ThreadHandoffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly originEnvironmentId: EnvironmentId;
  readonly originLabel: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly targetProjectId: ProjectId | null;
  readonly branch: string | null;
  /** The thread has an active run; sending must interrupt it first. */
  readonly isBusy: boolean;
  /** Interrupts the thread's current turn; resolves when the request is accepted. */
  readonly onInterrupt: () => Promise<void>;
  readonly onMoved?: (targetThreadId: ThreadId) => void;
}

/**
 * The steps, in the order they run. Split by whether the receiving repository
 * has been written to: cancelling is free up to and including the upload, and
 * is not offered afterwards because only the servers can undo an apply.
 */
const PHASE_LABELS: ReadonlyArray<{
  readonly phase: ThreadHandoffProgress["phase"] | "interrupt";
  readonly label: string;
  readonly safeToCancel: boolean;
}> = [
  { phase: "interrupt", label: "Finish the current turn", safeToCancel: true },
  { phase: "prepare", label: "Snapshot branch, changes and untracked files", safeToCancel: true },
  { phase: "depart", label: "Pause this thread here", safeToCancel: true },
  { phase: "upload", label: "Move the bundle across", safeToCancel: true },
  { phase: "apply", label: "Apply on the other machine", safeToCancel: false },
  { phase: "settle", label: "Hand the thread over", safeToCancel: false },
];

function phaseIndex(phase: ThreadHandoffProgress["phase"] | "interrupt"): number {
  return PHASE_LABELS.findIndex((entry) => entry.phase === phase);
}

/**
 * Digs the human-facing message out of a failure however it is wrapped —
 * a tagged error, a Cause holding one, or a defect — because the generic
 * fallback tells the user nothing they can act on.
 */
function extractFailureMessage(cause: unknown, targetLabel: string): string {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record["message"] === "string" && record["message"].length > 0) {
      return record["message"];
    }
    for (const key of ["cause", "error", "failure", "defect", "left", "value"]) {
      if (key in record) queue.push(record[key]);
    }
    for (const key of ["failures", "reasons", "errors"]) {
      if (Array.isArray(record[key])) queue.push(...(record[key] as unknown[]));
    }
  }
  return `Could not move this thread to ${targetLabel}. Check the console for details.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ThreadHandoffDialog({
  open,
  onOpenChange,
  threadId,
  threadTitle,
  originEnvironmentId,
  originLabel,
  targetEnvironmentId,
  targetLabel,
  targetProjectId,
  branch,
  isBusy,
  onInterrupt,
  onMoved,
}: ThreadHandoffDialogProps) {
  const move = useAtomCommand(threadHandoff.move, { reportFailure: false });
  const [progress, setProgress] = useState<
    ThreadHandoffProgress | { readonly phase: "interrupt" } | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMoving = progress !== null && errorMessage === null;
  // Send pressed while the agent was working: the turn was interrupted and
  // the transfer starts the moment the thread goes idle.
  const [sendQueued, setSendQueued] = useState(false);
  // Where the destination should clone when it does not have the repository.
  const [cloneWorkspaceRoot, setCloneWorkspaceRoot] = useState("");

  const startTransfer = useCallback(async () => {
    if (targetProjectId === null && cloneWorkspaceRoot.trim().length === 0) {
      setProgress(null);
      setErrorMessage(
        `${targetLabel} does not have this repository yet. Enter a folder to clone it into.`,
      );
      return;
    }
    setErrorMessage(null);
    setProgress({ phase: "prepare", transferredBytes: 0, totalBytes: 0 });
    const result = await move({
      threadId,
      originEnvironmentId,
      targetEnvironmentId,
      targetLabel,
      targetProjectId,
      cloneWorkspaceRoot: targetProjectId === null ? cloneWorkspaceRoot.trim() : null,
      returningThreadId: null,
      targetBranchTip: null,
      previousHandoffId: null,
      hopCount: 0,
      onProgress: setProgress,
    });
    if (result._tag === "Failure") {
      setProgress(null);
      // The server's message is written for this exact situation — a
      // divergence names the ref the commits were parked at, a payload
      // refusal names the size — so dig it out of however the failure is
      // wrapped before falling back to something generic.
      console.error("thread handoff failed", result.cause);
      setErrorMessage(extractFailureMessage(result.cause, targetLabel));
      return;
    }
    onOpenChange(false);
    setProgress(null);
    onMoved?.(result.value.targetThreadId);
  }, [
    move,
    onMoved,
    onOpenChange,
    originEnvironmentId,
    targetEnvironmentId,
    targetLabel,
    targetProjectId,
    cloneWorkspaceRoot,
    threadId,
  ]);

  const handleMove = useCallback(async () => {
    if (isBusy) {
      // Interrupt now, send when idle: the snapshot must never be cut while
      // the agent is writing the worktree.
      setErrorMessage(null);
      setProgress({ phase: "interrupt" });
      setSendQueued(true);
      await onInterrupt();
      return;
    }
    await startTransfer();
  }, [isBusy, onInterrupt, startTransfer]);

  useEffect(() => {
    if (sendQueued && !isBusy) {
      setSendQueued(false);
      void startTransfer();
    }
  }, [sendQueued, isBusy, startTransfer]);

  // The interrupt wait must not hang forever: if the thread has not gone
  // idle within a minute, surface it instead of showing Sending… until the
  // heat death of the universe.
  useEffect(() => {
    if (!sendQueued) return;
    const timer = setTimeout(() => {
      setSendQueued(false);
      setProgress(null);
      setErrorMessage(
        "The current turn did not finish within a minute. Stop it manually, then send again.",
      );
    }, 60_000);
    return () => clearTimeout(timer);
  }, [sendQueued]);

  const activeIndex = progress === null ? -1 : phaseIndex(progress.phase);
  const canCancel = progress === null || (PHASE_LABELS[activeIndex]?.safeToCancel ?? false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isMoving || canCancel) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send thread to {targetLabel}</DialogTitle>
          <DialogDescription>
            It keeps running there. {originLabel} keeps a read-only copy until you pull it back.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="border-border grid gap-1.5 rounded-md border p-3">
            <span className="text-xs font-medium">What travels</span>
            <span className="text-muted-foreground truncate text-xs">
              {branch === null ? "Current branch" : branch} · unpushed commits · uncommitted and
              untracked files
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {threadTitle} · the whole conversation · the model keeps its context
            </span>
          </div>

          {targetProjectId === null ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">
                {targetLabel} does not have this repository yet — clone it into
              </span>
              <input
                type="text"
                value={cloneWorkspaceRoot}
                placeholder="/home/user/code/repo"
                disabled={isMoving}
                onChange={(event) => setCloneWorkspaceRoot(event.target.value)}
                className="border-border bg-background rounded-md border px-2 py-1.5 text-xs"
              />
              <span className="text-muted-foreground text-xs">
                The whole history travels in the bundle, so the other machine needs no git
                credentials or network.
              </span>
            </label>
          ) : null}

          {progress === null ? null : (
            <div className="grid gap-1.5">
              {PHASE_LABELS.map((entry, index) => (
                <div key={entry.phase} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden
                    className={
                      index < activeIndex
                        ? "bg-foreground size-2 shrink-0 rounded-full"
                        : index === activeIndex
                          ? "bg-primary size-2 shrink-0 rounded-full"
                          : "bg-border size-2 shrink-0 rounded-full"
                    }
                  />
                  <span className={index <= activeIndex ? "" : "text-muted-foreground"}>
                    {entry.label}
                  </span>
                  {entry.phase === "upload" &&
                  index === activeIndex &&
                  progress.phase !== "interrupt" ? (
                    <span className="text-muted-foreground ml-auto">
                      {formatBytes(progress.transferredBytes)}
                      {progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ""}
                    </span>
                  ) : null}
                </div>
              ))}
              {canCancel ? null : (
                <span className="text-muted-foreground text-xs">
                  The other machine is being written to; this can no longer be cancelled here.
                </span>
              )}
            </div>
          )}

          {errorMessage === null ? null : (
            <p className="text-destructive text-xs" role="alert">
              {errorMessage}
            </p>
          )}
        </DialogPanel>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isMoving && !canCancel}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={isMoving} onClick={() => void handleMove()}>
            {isMoving ? "Sending…" : "Send thread"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
