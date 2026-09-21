/**
 * The single floating control over a pull request. Commenting on the change and submitting the
 * review that carries the Code tab's line comments used to float as two buttons that crowded
 * each other and read as the same offer twice; they are two modes of one composer now.
 *
 * Opening picks the mode with work waiting in it, so a reader who has collected line comments
 * lands on the review and everyone else lands on the comment box. Either mode's draft survives
 * the toggle: they are separate texts going to separate places, and merging them would send a
 * summary as a comment or the reverse.
 */
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import { usePendingReviewComments } from "./pullRequestReviewStore";

export function PullRequestComposer({
  environmentId,
  reference,
  detail,
  actionPending,
  onCommentAction,
  onCommented,
  onReviewSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  actionPending: boolean;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
  onReviewSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [requestedMode, setRequestedMode] = useState<"comment" | "review">("comment");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingComments = usePendingReviewComments(reference);

  // What is offered is the intersection of two different questions: what this host can do at
  // all, and what this account may do on this repository. Either one saying no means a control
  // that would only ever end in a refusal.
  const canComment = detail.capabilities.comment && detail.viewerPermissions.comment;
  const verdicts = detail.capabilities.review.verdicts.filter((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );
  if (!canComment && verdicts.length === 0) return null;

  const mode = canComment ? (verdicts.length === 0 ? "comment" : requestedMode) : "review";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setRequestedMode(pendingComments.length > 0 ? "review" : "comment");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button size="compact" variant="glass" className="rounded-full shadow-lg" />}
      >
        <MessageSquareIcon className="size-3.5" />
        {canComment && pendingComments.length === 0 ? "Comment" : "Review"}
        {pendingComments.length > 0 ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-accent text-[10px] tabular-nums text-accent-foreground">
            {pendingComments.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)]"
        initialFocus={textareaRef}
        aria-label="Pull request composer"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          {canComment && verdicts.length > 0 ? (
            <ToggleGroup
              aria-label="Composer mode"
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "comment" || value === "review") setRequestedMode(value);
              }}
            >
              <Toggle value="comment">Comment</Toggle>
              <Toggle value="review">
                {pendingComments.length > 0 ? `Review (${pendingComments.length})` : "Review"}
              </Toggle>
            </ToggleGroup>
          ) : (
            <PopoverTitle className="text-sm">
              {mode === "review" ? "Review pull request" : "Comment on pull request"}
            </PopoverTitle>
          )}
          <PopoverClose
            render={<Button size="icon-xs" variant="ghost" />}
            aria-label="Close composer"
          >
            <XIcon className="size-3.5" />
          </PopoverClose>
        </div>
        {mode === "review" ? (
          <PullRequestReviewForm
            environmentId={environmentId}
            reference={reference}
            verdicts={verdicts}
            requestChangesSummaryRequired={detail.provider === "forgejo"}
            textareaRef={textareaRef}
            onSubmitted={() => {
              setOpen(false);
              onReviewSubmitted();
            }}
          />
        ) : (
          <PullRequestCommentForm
            environmentId={environmentId}
            reference={reference}
            detail={detail}
            actionPending={actionPending}
            textareaRef={textareaRef}
            onCommentAction={onCommentAction}
            onCommented={onCommented}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
}
