import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueComment,
  IssueRichBody,
  IssueRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestActorLabel, PullRequestMetaLine } from "../pullRequest/pullRequestPresentation";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { InlineButton } from "../ui/button";
import { IssueRichBodyEditor, IssueRichBodyView } from "./IssueRichBodyEditor";
import { isEditableIssueRichBody } from "./issueAdf";
import { reportIssueResult } from "./issueMutation";

export function IssueCommentContent({
  environmentId,
  reference,
  comment,
  canEdit,
  richText = false,
  cwd,
  threadRef,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef & { readonly host: string };
  comment: IssueComment;
  canEdit: boolean;
  richText?: boolean;
  cwd: string;
  threadRef?: ScopedThreadRef | null;
  onChanged?: ((body: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedRich, setSavedRich] = useState<{
    base: IssueRichBody | undefined;
    value: IssueRichBody;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editComment = useAtomCommand(issueEnvironment.editComment, { reportFailure: false });
  const allowed = useAtomValue(issueEnvironment.editComment.permissionAtom(environmentId));
  if (saved !== null && saved === comment.body) setSaved(null);
  const body = saved ?? comment.body;
  const sameRichBody =
    savedRich !== null &&
    savedRich.base?.format === comment.richBody?.format &&
    savedRich.base?.document === comment.richBody?.document;
  if (savedRich !== null && !sameRichBody) setSavedRich(null);
  const richBody = savedRich !== null && sameRichBody ? savedRich.value : comment.richBody;
  const nativeRichBody = richText && isEditableIssueRichBody(richBody) ? richBody : undefined;
  const save = async (body: string, richBody?: IssueRichBody) => {
    if (
      !canEdit ||
      comment.canEdit === false ||
      !allowed ||
      saving ||
      (richBody !== undefined && !nativeRichBody)
    )
      return;
    setSaving(true);
    const result = await editComment({
      environmentId,
      input: {
        ...reference,
        commentId: comment.id,
        body,
        ...(richBody === undefined ? {} : { richBody }),
      },
    });
    setSaving(false);
    if (!reportIssueResult(result, "Could not save the comment")) return;
    setSaved(body);
    setSavedRich(richBody === undefined ? null : { base: comment.richBody, value: richBody });
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
        {canEdit &&
        comment.canEdit !== false &&
        allowed &&
        !editing &&
        (comment.richBody === undefined || nativeRichBody !== undefined) ? (
          <PullRequestEditButton aria-label="Edit comment" onClick={() => setEditing(true)} />
        ) : null}
      </PullRequestMetaLine>
      {editing && nativeRichBody ? (
        <IssueRichBodyEditor
          value={nativeRichBody}
          label="Edit comment"
          saving={saving}
          disabled={!canEdit || comment.canEdit === false || !allowed}
          onSave={(next) => void save(body, next)}
          onCancel={() => setEditing(false)}
        />
      ) : editing && comment.richBody === undefined ? (
        <PullRequestMarkdownEditor
          value={body}
          cwd={cwd}
          environmentId={environmentId}
          label="Edit comment"
          threadRef={threadRef ?? null}
          issueLinkContext={{ ...reference, environmentId }}
          saving={saving}
          onSave={(next) => void save(next)}
          onCancel={() => setEditing(false)}
        />
      ) : nativeRichBody ? (
        <IssueRichBodyView value={nativeRichBody} />
      ) : (
        <PullRequestCommentBody
          text={body}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? null}
          issueLinkContext={{ ...reference, environmentId }}
        />
      )}
    </>
  );
}
