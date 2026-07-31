/**
 * What sits under a line of the diff: a conversation already on the host, a comment queued for
 * the review being written, or the box that writes one.
 */
import type { PullRequestReviewThread } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleIcon, MessageSquareIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import type { PendingReviewComment } from "./pullRequestReviewStore";

const CARD_CLASS =
  "mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm";

/** Sends on ⌘/Ctrl+Enter and abandons on Escape, which is what every other composer here does. */
function submitKeys(input: {
  readonly value: string;
  readonly onSubmit: () => void;
  readonly onCancel?: (() => void) | undefined;
}) {
  return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && input.onCancel) {
      event.preventDefault();
      input.onCancel();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && input.value.trim()) {
      event.preventDefault();
      input.onSubmit();
    }
  };
}

/** The box that writes a new line comment into the review being drafted. */
export function ReviewCommentComposer({
  lineLabel,
  pending,
  onCancel,
  onSubmit,
}: {
  lineLabel: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const submit = () => {
    const trimmed = body.trim();
    if (trimmed.length > 0) onSubmit(trimmed);
  };
  return (
    <div
      className={cn(CARD_CLASS, "shadow-lg")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>Comment on {lineLabel}</span>
      </div>
      <Textarea
        autoFocus
        size="sm"
        className="mt-2"
        value={body}
        placeholder="Leave a comment"
        aria-label={`Comment on ${lineLabel}`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={submitKeys({ value: body, onSubmit: submit, onCancel })}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={pending || body.trim().length === 0} onClick={submit}>
          Add to review
        </Button>
      </div>
    </div>
  );
}

/** A comment waiting to be sent with the rest of the review. */
export function PendingReviewCommentCard({
  comment,
  onRemove,
}: {
  comment: PendingReviewComment;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(CARD_CLASS, "border-dashed")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>Pending — sent when you submit the review</span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Discard this comment"
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
    </div>
  );
}

/** A conversation already on the host, with whatever this host lets the reader do to it. */
export function ReviewThreadCard({
  thread,
  workspaceRoot,
  canReply,
  canResolve,
  pending,
  onReply,
  onToggleResolved,
}: {
  thread: PullRequestReviewThread;
  workspaceRoot: string;
  canReply: boolean;
  canResolve: boolean;
  pending: boolean;
  onReply: (body: string) => void;
  onToggleResolved: () => void;
}) {
  // A resolved thread is finished work, so it opens collapsed and stays one line until asked for.
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");

  const send = () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0) return;
    onReply(trimmed);
    setReply("");
    setReplying(false);
  };

  return (
    <div
      className={CARD_CLASS}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {thread.isResolved ? (
          <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <button
          type="button"
          className="hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {thread.isResolved ? "Resolved" : "Open"} · {thread.comments.length}{" "}
          {thread.comments.length === 1 ? "comment" : "comments"}
        </button>
        {thread.isOutdated ? <span>outdated</span> : null}
        {canResolve ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={pending}
            onClick={onToggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <div className="mt-2 space-y-3">
            {thread.comments.map((comment) => (
              <article key={comment.id} className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={comment.author} className="text-foreground" />
                  <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                </div>
                <PullRequestMarkdown
                  className="mt-1 text-sm"
                  text={comment.body}
                  cwd={workspaceRoot}
                />
              </article>
            ))}
          </div>

          {canReply ? (
            replying ? (
              <div className="mt-2">
                <Textarea
                  autoFocus
                  size="sm"
                  value={reply}
                  placeholder="Reply"
                  aria-label="Reply to this conversation"
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={submitKeys({
                    value: reply,
                    onSubmit: send,
                    onCancel: () => setReplying(false),
                  })}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={pending || reply.trim().length === 0} onClick={send}>
                    Reply
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="mt-2 px-1"
                onClick={() => setReplying(true)}
              >
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
