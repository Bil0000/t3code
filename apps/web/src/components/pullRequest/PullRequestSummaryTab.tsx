import type { EnvironmentId, PullRequestDetail } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitMergeIcon,
  MessageSquareIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  PullRequestDiffStat,
  PullRequestMetaLine,
  pullRequestCheckStatusLabel,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";
import { describePullRequestState } from "./pullRequestDetail.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

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
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Title first, chevron riding to its right, count last: the row reads as a heading
          with an affordance rather than a tree node. */}
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 border-t border-border/60 px-5 py-3 text-left text-sm font-medium">
        <span>{title}</span>
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        {count === undefined ? null : (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-5 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function CommentComposer({
  environmentId,
  detail,
  onCommented,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestDetail;
  onCommented: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const postComment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });

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
        aria-label="Comment on this pull request"
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

export function PullRequestSummaryTab({
  environmentId,
  detail,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestDetail;
  onRefresh: () => void;
}) {
  const openCheck = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto">
      <section className="space-y-4 px-5 py-5">
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-snug">{detail.title}</h1>
          <PullRequestMetaLine className="mt-1.5 text-xs text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} className="font-medium text-foreground" />
            <span>{formatRelativeTimeLabel(detail.updatedAt)}</span>
            <span>{describePullRequestState(detail.state, detail.isDraft)}</span>
          </PullRequestMetaLine>
        </div>
        <div>
          <MetaRow icon={<GitBranchIcon className="size-3.5" />} label="Branch">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate" title={detail.headBranch}>
                {detail.headBranch}
              </span>
              <span aria-hidden className="shrink-0 text-muted-foreground">
                ›
              </span>
              <span className="min-w-0 truncate" title={detail.baseBranch}>
                {detail.baseBranch}
              </span>
              <PullRequestDiffStat
                additions={detail.additions}
                deletions={detail.deletions}
                className="ml-1 shrink-0"
              />
            </span>
          </MetaRow>
          {detail.state === "open" && detail.mergeability === "conflicting" ? (
            <MetaRow icon={<GitMergeIcon className="size-3.5 text-destructive" />} label="Merge">
              Conflicts with {detail.baseBranch}
            </MetaRow>
          ) : null}
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Reviewers">
            {detail.reviewers.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                {detail.reviewers.map((actor) => (
                  <PullRequestActorLabel key={actor.login} actor={actor} className="max-w-32" />
                ))}
              </span>
            )}
          </MetaRow>
          <MetaRow icon={<MessageSquareIcon className="size-3.5" />} label="Comments">
            {detail.comments.length === 1 ? "1 comment" : `${detail.comments.length} comments`}
          </MetaRow>
          <MetaRow icon={<CircleDotIcon className="size-3.5" />} label="Checks">
            {summarizePullRequestChecks(detail.checks)}
          </MetaRow>
        </div>
      </section>

      <Section title="Description">
        <PullRequestMarkdown
          text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
          cwd={detail.workspaceRoot}
        />
      </Section>

      <Section title="Checks" count={detail.checks.length}>
        {detail.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No checks reported.</p>
        ) : (
          <div className="space-y-0.5">
            {detail.checks.map((check) => (
              <button
                key={`${check.name}:${check.url ?? ""}`}
                type="button"
                disabled={!check.url}
                onClick={() => check.url && openCheck(check.url)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  check.url ? "hover:bg-accent/60" : "cursor-default",
                )}
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {pullRequestCheckStatusLabel(check.status)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Comments" count={detail.comments.length}>
        {detail.commentsTruncated ? (
          <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
            Some comments could not be shown here. Open the change request to read them all.
          </p>
        ) : null}
        {detail.comments.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="space-y-3">
            {detail.comments.map((comment) => (
              <article key={comment.id} className="rounded-lg border border-border/60 p-3">
                <PullRequestMetaLine className="text-xs text-muted-foreground">
                  <PullRequestActorLabel
                    actor={comment.author}
                    className="font-medium text-foreground"
                  />
                  <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                  {comment.reviewState ? <span>{comment.reviewState.toLowerCase()}</span> : null}
                </PullRequestMetaLine>
                {comment.path ? (
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={comment.path}>
                    {comment.path}
                  </p>
                ) : null}
                <PullRequestMarkdown
                  className="mt-2"
                  text={comment.body}
                  cwd={detail.workspaceRoot}
                />
              </article>
            ))}
          </div>
        )}
        {/* A host that cannot post a comment gets no composer, rather than one that fails. */}
        {detail.capabilities.comment ? (
          <CommentComposer environmentId={environmentId} detail={detail} onCommented={onRefresh} />
        ) : null}
      </Section>
    </div>
  );
}
