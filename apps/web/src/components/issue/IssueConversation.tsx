import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueComment, IssueRef, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestActorLabel, PullRequestMetaLine } from "../pullRequest/pullRequestPresentation";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { InlineButton } from "../ui/button";
import { reportIssueResult } from "./issueMutation";

export function IssueCommentContent({
  environmentId,
  reference,
  comment,
  canEdit,
  cwd,
  threadRef,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  comment: IssueComment;
  canEdit: boolean;
  cwd: string;
  threadRef?: ScopedThreadRef | null;
  onChanged?: ((body: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const editComment = useAtomCommand(issueEnvironment.editComment, { reportFailure: false });
  const allowed = useAtomValue(issueEnvironment.editComment.permissionAtom(environmentId));
  if (saved !== null && saved === comment.body) setSaved(null);
  const body = saved ?? comment.body;
  const save = async (body: string) => {
    setSaving(true);
    const result = await editComment({
      environmentId,
      input: { ...reference, commentId: comment.id, body },
    });
    setSaving(false);
    if (!reportIssueResult(result, "Could not save the comment")) return;
    setSaved(body);
    setEditing(false);
    onChanged?.(body);
  };
  return (
    <>
      <PullRequestMetaLine className="text-xs text-muted-foreground">
        <PullRequestActorLabel actor={comment.author} />
        {comment.url ? (
          <InlineButton
            className="text-muted-foreground"
            render={<a href={comment.url} target="_blank" rel="noopener noreferrer" />}
          >
            {formatRelativeTimeLabel(comment.createdAt)}
          </InlineButton>
        ) : (
          <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
        )}
        {comment.editedAt ? <span>edited</span> : null}
        {canEdit && comment.canEdit === true && allowed && !editing ? (
          <PullRequestEditButton aria-label="Edit comment" onClick={() => setEditing(true)} />
        ) : null}
      </PullRequestMetaLine>
      {editing ? (
        <PullRequestMarkdownEditor
          value={body}
          cwd={cwd}
          environmentId={environmentId}
          label="Edit comment"
          saving={saving}
          onSave={(next) => void save(next)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <PullRequestCommentBody
          text={body}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? null}
        />
      )}
    </>
  );
}
