import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueDetailView,
  IssueLinkedPullRequest,
  IssueRef,
} from "@t3tools/contracts";
import {
  ChevronRightIcon,
  LinkIcon,
  MessageSquareIcon,
  MilestoneIcon,
  SendIcon,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SourceControlActorLabel, SourceControlMetaLine } from "../sourceControl/actorPresentation";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { readableFailure } from "../sourceControl/handoff";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { IssueActivityUnavailableState } from "./IssueActivityUnavailableState";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { LINK_PULL_REQUESTS_HANDOFF_KIND } from "./issueDetail.logic";
import { IssueConversationGhost } from "./IssueGhosts";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueLabelChips } from "./issuePresentation";

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-xs">
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

function Section({
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** Controls riding on the heading row itself. A sibling of the trigger, not a child of it —
      a button cannot hold a button — and only while open, since they act on what is shown. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex w-full items-center border-t border-border/60 pr-4">
        {/* Title first, chevron riding to its right, count last: the row reads as a heading
            with an affordance rather than a tree node. */}
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-sm font-medium">
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {count === undefined ? null : (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
        </CollapsibleTrigger>
        {open ? actions : null}
      </div>
      <CollapsiblePanel>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Rewriting the issue where it is read, rather than in a dialog over the top of it: what the
 * description says in context is most of what an edit is about. The fields open on what the host
 * currently holds and are abandoned wholesale on cancel — half an edit is not worth keeping.
 */
function IssueEditor({
  environmentId,
  detail,
  onDone,
  onSaved,
}: {
  environmentId: EnvironmentId;
  detail: IssueDetailView;
  onDone: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(detail.title);
  const [body, setBody] = useState(detail.body);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });

  const trimmedTitle = title.trim();
  const changedTitle = trimmedTitle !== detail.title;
  const changedBody = body !== detail.body;

  const save = async () => {
    if (trimmedTitle.length === 0 || saving) return;
    if (!changedTitle && !changedBody) {
      onDone();
      return;
    }
    setSaving(true);
    const result = await update({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        // Only what changed: a rename should not resend a description nobody edited.
        ...(changedTitle ? { title: trimmedTitle } : {}),
        ...(changedBody ? { body } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not save this issue",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access, or that you opened it.",
        ),
      });
      return;
    }
    onDone();
    onSaved();
  };

  return (
    <div className="space-y-2">
      <Input
        disabled={saving}
        value={title}
        aria-label="Issue title"
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        disabled={saving}
        value={body}
        rows={12}
        placeholder="Describe the issue"
        aria-label="Issue description"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={trimmedTitle.length === 0 || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function CommentComposer({
  environmentId,
  detail,
  onCommented,
}: {
  environmentId: EnvironmentId;
  detail: IssueDetailView;
  onCommented: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const postComment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });

  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    const result = await postComment({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        body: trimmed,
      },
    });
    setPosting(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
    onCommented();
  };

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        // Locked while posting: the body is cleared on success, which would otherwise throw
        // away a new draft typed while the request was still in flight.
        disabled={posting}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment on this issue"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={body.trim().length === 0 || posting}
          onClick={() => void submit()}
        >
          <SendIcon className="size-3.5" />
          {posting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a first render of the conversation carries. An issue with two hundred comments is two
 * hundred markdown documents, and the ones worth arriving for are the recent ones.
 */
const COMMENT_PAGE = 30;

export function IssueSummaryTab({
  environmentId,
  reference,
  detail,
  activityPending,
  activityError,
  editing,
  onEditingChange,
  openPicker,
  onOpenPickerChange,
  pendingHandoff,
  onLinkPullRequests,
  onOpenLinkedPullRequest,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetailView;
  activityPending: boolean;
  activityError: string | null;
  /** Owned by the panel, whose menu offers the edit and whose header decides it is allowed. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /**
   * Which of the two pickers is open, held by the panel so its own menu items can open one —
   * the meta row is where they live, and it is a tab away when the menu is pressed.
   */
  openPicker: "labels" | "assignees" | null;
  onOpenPickerChange: (picker: "labels" | "assignees" | null) => void;
  /** The hand-off currently preparing, if any, so only the control that started it says so. */
  pendingHandoff?: string | null;
  /**
   * Hands the question of which change requests address this issue to an agent. Supplied by
   * whoever mounted the panel, because only they can open a thread for it; without one the
   * section offers nothing, which is never a dead control.
   */
  onLinkPullRequests?: () => void;
  onOpenLinkedPullRequest: (link: IssueLinkedPullRequest) => void;
  onRefresh: () => void;
}) {
  // Keyed by the issue, so opening another one starts at the end of its conversation rather than
  // wherever the last one had been read back to.
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const shownComments = shown.url === detail.url ? shown.count : COMMENT_PAGE;
  // An issue reads in the order it was written, so the window reaches backwards from the end.
  const recentComments = detail.comments.slice(Math.max(0, detail.comments.length - shownComments));
  const hiddenCommentCount = detail.comments.length - recentComments.length;

  return (
    <div className="h-full overflow-y-auto">
      <section className="px-4 py-3">
        <div>
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {detail.assignees.length === 0 ? (
                <span className="text-muted-foreground">Nobody</span>
              ) : (
                detail.assignees.map((actor) => (
                  <SourceControlActorLabel key={actor.login} actor={actor} className="shrink-0" />
                ))
              )}
              {/* Shown wherever the host can assign at all, and disabled with the reason where
                  this account may not: a control that vanishes teaches nobody why. A host that
                  takes an assignee but will not say who could be one has nothing to open. */}
              {detail.capabilities.assignees && detail.capabilities.listAssigneeCandidates ? (
                <IssueAssigneePicker
                  environmentId={environmentId}
                  reference={reference}
                  allowed={detail.viewerPermissions.assignees}
                  open={openPicker === "assignees"}
                  onOpenChange={(open) => onOpenPickerChange(open ? "assignees" : null)}
                  onChanged={onRefresh}
                />
              ) : null}
            </span>
          </MetaRow>
          <MetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {detail.labels.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <IssueLabelChips labels={detail.labels} max={detail.labels.length} />
              )}
              {detail.capabilities.labels && detail.capabilities.listLabelCandidates ? (
                <IssueLabelPicker
                  environmentId={environmentId}
                  reference={reference}
                  applied={detail.labels.map((label) => label.name)}
                  allowed={detail.viewerPermissions.labels}
                  open={openPicker === "labels"}
                  onOpenChange={(open) => onOpenPickerChange(open ? "labels" : null)}
                  onChanged={onRefresh}
                />
              ) : null}
            </span>
          </MetaRow>
          <MetaRow icon={<MilestoneIcon className="size-3.5" />} label="Milestone">
            {detail.milestone ?? <span className="text-muted-foreground">None</span>}
          </MetaRow>
          <MetaRow icon={<MessageSquareIcon className="size-3.5" />} label="Comments">
            {activityPending
              ? "Loading conversation…"
              : activityError
                ? "Conversation unavailable"
                : detail.commentCount === 1
                  ? "1 comment"
                  : `${detail.commentCount} comments`}
          </MetaRow>
        </div>
      </section>

      <Section title="Description">
        {editing ? (
          <IssueEditor
            environmentId={environmentId}
            detail={detail}
            onDone={() => onEditingChange(false)}
            onSaved={onRefresh}
          />
        ) : (
          <HostMarkdown
            text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
            cwd={detail.workspaceRoot}
          />
        )}
      </Section>

      {/* Only where the host reports links at all: an empty section under a host that never
          answers this question says the issue has no work on it, which it cannot know. */}
      {detail.capabilities.linkedPullRequests ? (
        <Section
          title="Related pull requests"
          count={detail.linkedPullRequests.length}
          // Offered whether or not anything is listed: an issue one change already mentions can
          // still be worked on by another that never named it.
          actions={
            onLinkPullRequests ? (
              <Button
                size="xs"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-[10px] text-muted-foreground"
                disabled={pendingHandoff !== null && pendingHandoff !== undefined}
                onClick={onLinkPullRequests}
              >
                <LinkIcon aria-hidden className="size-3" />
                {pendingHandoff === LINK_PULL_REQUESTS_HANDOFF_KIND
                  ? "Preparing..."
                  : "Link with agent"}
              </Button>
            ) : null
          }
        >
          {detail.linkedPullRequests.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pull request mentions this issue.</p>
          ) : (
            <div className="space-y-0.5">
              {detail.linkedPullRequests.map((link) => {
                const presentation = resolvePullRequestState({
                  state: link.state,
                  isDraft: link.isDraft,
                });
                return (
                  <button
                    key={`${link.repository}#${link.number}`}
                    type="button"
                    // Beside the issue rather than instead of it: reading the change that closes
                    // an issue is reading them together.
                    onClick={() => onOpenLinkedPullRequest(link)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60"
                  >
                    <presentation.Icon
                      role="img"
                      aria-label={presentation.label}
                      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
                    />
                    <span className="min-w-0 flex-1 truncate">{link.title}</span>
                    {link.closesIssue ? (
                      <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                        closes this
                      </span>
                    ) : null}
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      #{link.number}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      ) : null}

      <Section
        title="Comments"
        {...(activityPending || activityError ? {} : { count: detail.commentCount })}
      >
        {activityPending ? (
          <IssueConversationGhost />
        ) : activityError ? (
          <IssueActivityUnavailableState compact error={activityError} onRetry={onRefresh} />
        ) : (
          <>
            {detail.commentsTruncated ? (
              <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                This conversation is longer than this page reads in one go. The most recent{" "}
                {detail.comments.length} are here; open it on the host to read the rest.
              </p>
            ) : null}
            {detail.comments.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : (
              <div className="space-y-3">
                {hiddenCommentCount > 0 ? (
                  // Hundreds of comments are hundreds of markdown renders, and the ones worth
                  // opening an issue for are the recent ones. The rest are one press away and
                  // stay rendered once asked for.
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() =>
                      setShown({ url: detail.url, count: shownComments + COMMENT_PAGE })
                    }
                  >
                    Show {Math.min(hiddenCommentCount, COMMENT_PAGE)} earlier{" "}
                    {hiddenCommentCount === 1 ? "comment" : "comments"}
                  </Button>
                ) : null}
                {recentComments.map((comment) => (
                  <article
                    key={comment.id}
                    // Offscreen comments skip style, layout and paint. Bot comments carry pages
                    // of highlighted code, and the conversation is below the description either
                    // way.
                    className="rounded-lg border border-border/60 p-3 [contain-intrinsic-block-size:120px] [content-visibility:auto]"
                  >
                    <SourceControlMetaLine className="min-w-0 text-xs text-muted-foreground">
                      <SourceControlActorLabel
                        actor={comment.author}
                        className="font-medium text-foreground"
                      />
                      <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                    </SourceControlMetaLine>
                    <HostMarkdown className="mt-2" text={comment.body} cwd={detail.workspaceRoot} />
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        {/* Posting is a core capability and remains usable even if the activity read failed. */}
        {detail.capabilities.comment && detail.viewerPermissions.comment ? (
          <CommentComposer
            key={`${environmentId}:${detail.projectId}/${detail.repository}#${detail.number}`}
            environmentId={environmentId}
            detail={detail}
            onCommented={onRefresh}
          />
        ) : null}
      </Section>
    </div>
  );
}
