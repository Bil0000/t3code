import { useAtomValue } from "@effect/atom-react";
import { reportIssueResult } from "./issueMutation";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, threadIssueKeysEqual } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueActor,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueLinkedPullRequest,
  IssueLabel,
  IssueReaction,
  IssueReactionContent,
  IssueRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  SendIcon,
  SmilePlusIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useIssueViewRefresh } from "~/hooks/useIssueViewRefresh";
import { useIssueThreadHandoff } from "./useIssueThreadHandoff";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";
import { issueEnvironment, useIssueLinkedPullRequests } from "~/state/issues";
import { IssueLoadMore } from "./IssueLoadMore";
import { IssueHistory } from "./IssueHistory";
import { IssueHierarchySection } from "./IssueRelations";
import { IssueCommentContent } from "./IssueConversation";
import { IssueCreateDialog } from "./IssueCreateDialog";
import { ISSUES_PANEL_REF, useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestDetailTitleRow,
  PullRequestDetailTabBar,
} from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaLine,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  applyPendingPullRequestReactions,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "../pullRequest/pullRequestReactions.logic";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import {
  issueCloseReasonLabel,
  IssueStateGlyph,
  issueTrackerPresentation,
} from "./issuePresentation";
import {
  issueAssigneeId,
  appendOlderIssueComments,
  editRetainedIssueComment,
  issueCommentsView,
  type IssueOlderComments,
  issueDisplayLabel,
  issueLabelId,
  heldIssuePicker,
  issuePickerIds,
  type IssuePickerConfirmed,
  issueStateActionLabel,
  sameIssueState,
  issueSupportsReactions,
  offeredIssueReactionContents,
  retainUnacknowledgedIssueReactions,
  linkedPullRequestTarget,
  type IssueLinkedPullRequestTarget,
} from "./issueDetail.logic";

/**
 * Links or unlinks the issue to the thread it is shown beside. Dispatches the orchestration
 * command directly, as pull request linking does; the server reads the snapshot afterwards.
 */
function IssueThreadLinkButton({
  environmentId,
  reference,
  url,
  threadRef,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  url: string;
  threadRef: ScopedThreadRef;
}) {
  const thread = useThreadShell(threadRef.environmentId === environmentId ? threadRef : null);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const link = useAtomCommand(threadEnvironment.linkIssue, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (thread === null || !canOperate) return null;
  const key = { ...reference, host: reference.host ?? "" };
  const linked = (thread.issues ?? []).some((existing) => threadIssueKeysEqual(existing, key));
  const toggle = async () => {
    if (pending || reference.host === undefined) return;
    setPending(true);
    const result = await (linked
      ? unlink({ environmentId, input: { threadId: threadRef.threadId, ...key } })
      : link({
          environmentId,
          input: { threadId: threadRef.threadId, ...key, url, source: "manual" },
        }));
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: linked ? "Could not unlink the issue" : "Could not link the issue",
        description: readableFailure(squashAtomCommandFailure(result), "The server refused it."),
      });
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={linked ? "Unlink from thread" : "Link to thread"}
            aria-pressed={linked}
            disabled={pending || reference.host === undefined}
            onClick={() => void toggle()}
          />
        }
      >
        {linked ? (
          <Link2OffIcon aria-hidden className="size-3.5" />
        ) : (
          <Link2Icon aria-hidden className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup>{linked ? "Unlink from this thread" : "Link to this thread"}</TooltipPopup>
    </Tooltip>
  );
}

/** Why a control is off, said once so each disabled affordance can point at it. */
function writeBlockReason(detail: IssueDetail, canWrite: boolean): string | null {
  if (!canWrite) return "Writing to this tracker needs the source-control write scope.";
  if (!detail.writable)
    return "This issue is outside every project's own scope, so it is read-only here.";
  return null;
}

function IssueTruncatedNote({
  text,
  url,
  providerName,
}: {
  text: string;
  url: string;
  providerName: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {text}{" "}
      <InlineButton
        tone="muted"
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      >
        View on {providerName}
      </InlineButton>
    </p>
  );
}

const REACTION_PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The pull-request reaction bar's shape, routed to the issue tracker instead of the host. */
export function IssueReactionBar({
  reactions,
  canReact,
  contents,
  subjectId,
  environmentId,
  reference,
}: {
  reactions: ReadonlyArray<IssueReaction>;
  canReact: boolean;
  contents: ReadonlyArray<IssueReactionContent> | undefined;
  subjectId?: string | undefined;
  environmentId: EnvironmentId;
  reference: IssueRef;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState({
    native: reactions,
    values: new Map<IssueReactionContent, boolean>() as ReadonlyMap<IssueReactionContent, boolean>,
  });
  const [busy, setBusy] = useState<ReadonlySet<IssueReactionContent>>(new Set());
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  const values =
    pending.native === reactions
      ? pending.values
      : retainUnacknowledgedIssueReactions(reactions, pending.values);
  if (pending.native !== reactions) setPending({ native: reactions, values });
  const shown = applyPendingPullRequestReactions(reactions, values);
  const offered = offeredIssueReactionContents(contents);

  const toggle = async (content: IssueReactionContent, reacted: boolean) => {
    if (busy.has(content)) return;
    setBusy((current) => new Set([...current, content]));
    setPending({ native: reactions, values: new Map([...values, [content, reacted]]) });
    const result = await react({
      environmentId,
      input: { ...reference, ...(subjectId === undefined ? {} : { subjectId }), content, reacted },
    });
    setBusy((current) => {
      const next = new Set(current);
      next.delete(content);
      return next;
    });
    if (result._tag === "Failure") {
      setPending((current) => {
        const next = new Map(current.values);
        const previous = values.get(content);
        if (previous === undefined) next.delete(content);
        else next.set(content, previous);
        return { native: current.native, values: next };
      });
      toastManager.add({ type: "error", title: "The reaction could not be saved" });
    }
  };

  if (shown.length === 0 && !canReact) return null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={reaction.viewerHasReacted}
                aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
                disabled={
                  !canReact || !offered.includes(reaction.content) || busy.has(reaction.content)
                }
                className={cn(
                  REACTION_PILL_CLASS,
                  reaction.viewerHasReacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground",
                  canReact ? "hover:border-primary/60" : "cursor-default",
                )}
                onClick={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
              />
            }
          >
            <span aria-hidden>{pullRequestReactionEmoji(reaction.content)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{pullRequestReactionTooltip(reaction)}</TooltipPopup>
        </Tooltip>
      ))}
      {canReact && offered.length > 0 ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Add a reaction"
                className={cn(
                  REACTION_PILL_CLASS,
                  "border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                )}
              />
            }
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" side="top" padding="compact">
            <div className="flex items-center gap-0.5">
              {offered.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    disabled={busy.has(content)}
                    aria-label={pullRequestReactionName(content)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      reacted && "bg-primary/10",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      void toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

function eventSentence(event: IssueEvent): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? `closed this as ${issueCloseReasonLabel(event.detail).toLowerCase()}`
        : "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return event.detail ? `added the ${event.detail} label` : "added a label";
    case "unlabeled":
      return event.detail ? `removed the ${event.detail} label` : "removed a label";
    case "assigned":
      return event.detail ? `assigned ${event.detail}` : "assigned someone";
    case "unassigned":
      return event.detail ? `unassigned ${event.detail}` : "unassigned someone";
    case "renamed":
      return event.detail ? `renamed this to “${event.detail}”` : "renamed this";
    case "referenced":
      return event.detail ? `referenced this from ${event.detail}` : "referenced this";
    case "state-changed":
      return event.detail ? `moved this to ${event.detail}` : "changed the state";
    case "changed":
    case "updated":
      return event.detail ? `${event.kind} ${event.detail}` : `${event.kind} this`;
  }
}

type TimelineItem =
  | { kind: "comment"; at: string; comment: IssueComment }
  | { kind: "event"; at: string; event: IssueEvent };

function LinkedPullRequestRow({
  link,
  onSelect,
}: {
  link: IssueLinkedPullRequest;
  onSelect: (() => void) | null;
}) {
  const body = (
    <>
      {link.state === null ? (
        <PullRequestGlyph.pullRequest
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateGlyph state={link.state} isDraft={link.isDraft} />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{link.title}</span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {link.repository}#{link.number}
      </span>
      {link.closesIssue ? (
        <span className="shrink-0 text-2xs text-muted-foreground">closes</span>
      ) : null}
    </>
  );
  const className =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60";
  return onSelect ? (
    <button type="button" className={className} onClick={onSelect}>
      {body}
    </button>
  ) : (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  );
}

type IssueDetailPanelProps = {
  environmentId: EnvironmentId;
  reference: IssueRef;
  threadRef?: ScopedThreadRef | null;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((target: IssueLinkedPullRequestTarget) => void) | undefined;
  onUpdated?: (() => void) | undefined;
};

export function IssueDetailPanel(props: IssueDetailPanelProps) {
  const ref = props.reference;
  return (
    <IssueDetailContent
      key={JSON.stringify([
        props.environmentId,
        ref.projectId,
        ref.tracker,
        ref.host,
        ref.scope,
        ref.key,
      ])}
      {...props}
    />
  );
}

function IssueDetailContent({
  environmentId,
  reference,
  threadRef = null,
  onSelectPullRequest,
  onUpdated,
}: IssueDetailPanelProps) {
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  useIssueViewRefresh(
    detailQuery.refresh,
    [{ environmentId, input: reference }],
    JSON.stringify([environmentId, reference]),
  );
  const handoff = useIssueThreadHandoff(environmentId, reference);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const detail = detailQuery.data;
  const canWrite = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const projects = useProjects();
  const cwd =
    projects.find((p) => p.environmentId === environmentId && p.id === reference.projectId)
      ?.workspaceRoot ?? "";

  const [tab, setTab] = useState<"summary" | "history">("summary");
  const [createSubIssue, setCreateSubIssue] = useState(false);
  const linkedPages = useIssueLinkedPullRequests(
    environmentId,
    detail?.capabilities.linkedPullRequests ? reference : null,
  );
  const [older, setOlder] = useState<IssueOlderComments | null>(null);
  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [updatingMetadata, setUpdatingMetadata] = useState(false);
  const [confirmedLabels, setConfirmedLabels] = useState<
    (IssuePickerConfirmed & { items: ReadonlyArray<IssueLabel> }) | null
  >(null);
  const [confirmedAssignees, setConfirmedAssignees] = useState<
    (IssuePickerConfirmed & { items: ReadonlyArray<IssueActor> }) | null
  >(null);
  const [stateMenuOpen, setStateMenuOpen] = useState(false);
  const needsStateCandidates = detail?.tracker === "jira" && (detail.states?.length ?? 0) <= 1;
  const stateCandidates = useEnvironmentQuery(
    stateMenuOpen &&
      needsStateCandidates &&
      canWrite &&
      detail?.writable &&
      detail.viewerPermissions.setState &&
      detail.capabilities.states.length > 0
      ? issueEnvironment.candidates({
          environmentId,
          input: {
            projectId: reference.projectId,
            tracker: reference.tracker,
            host: reference.host,
            scope: reference.scope,
          },
        })
      : null,
  );

  if (detail === null) {
    if (detailQuery.error !== null && !detailQuery.isPending) {
      return (
        <PullRequestsUnavailableState
          title="Could not load this issue"
          error={detailQuery.error}
          onRetry={detailQuery.refresh}
        />
      );
    }
    return <PullRequestDetailGhost />;
  }

  const activeTab = detail.capabilities.events ? tab : "summary";
  const heldLabels = heldIssuePicker(detail, "labels", confirmedLabels, environmentId);
  const heldAssignees = heldIssuePicker(detail, "assignees", confirmedAssignees, environmentId);
  if (heldLabels === null && confirmedLabels !== null) setConfirmedLabels(null);
  if (heldAssignees === null && confirmedAssignees !== null) setConfirmedAssignees(null);
  const labelObjects = new Map(
    [...(confirmedLabels?.items ?? []), ...detail.labels].map((label) => [
      issueLabelId(label),
      label,
    ]),
  );
  const actorObjects = new Map(
    [...(confirmedAssignees?.items ?? []), ...detail.assignees].map((actor) => [
      issueAssigneeId(actor).toLowerCase(),
      actor,
    ]),
  );
  const labels = issuePickerIds(detail, "labels", heldLabels, environmentId).map((id) =>
    labelObjects.get(id)!,
  );
  const assignees = issuePickerIds(detail, "assignees", heldAssignees, environmentId).map((id) =>
    actorObjects.get(id.toLowerCase())!,
  );
  const { comments, cursor: nextCursor, held: heldComments } = issueCommentsView(detail, older);
  const timeline: ReadonlyArray<TimelineItem> = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", at: c.createdAt, comment: c })),
    ...detail.events.map((e): TimelineItem => ({ kind: "event", at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const blocked = writeBlockReason(detail, canWrite);
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  const canComment = may(detail.capabilities.comment, detail.viewerPermissions.comment);
  const canEdit = may(detail.capabilities.edit, detail.viewerPermissions.edit);
  const canLabel = may(detail.capabilities.labels, detail.viewerPermissions.labels);
  const canAssign = may(detail.capabilities.assignees, detail.viewerPermissions.assignees);
  const canReact = blocked === null && detail.capabilities.reactions;
  const canReactToComment = blocked === null && issueSupportsReactions(detail.capabilities, true);
  const canSetState = may(detail.capabilities.states.length > 0, detail.viewerPermissions.setState);
  const tracker = issueTrackerPresentation(detail.tracker);
  const states = needsStateCandidates
    ? stateCandidates.error === null
      ? (stateCandidates.data?.states ?? [])
      : []
    : (detail.states ?? detail.capabilities.states);
  const otherStates = states.filter((state) => !sameIssueState(state, detail.state));
  const closingStates = otherStates.filter((state) => state.category === "closed");
  const openingStates = otherStates.filter((state) => state.category === "open");

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    const result = await loadComments({
      environmentId,
      input: { ...reference, cursor: nextCursor },
    });
    setLoadingOlder(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Older comments could not be read" });
      return;
    }
    setOlder(appendOlderIssueComments(detail, heldComments, result.value));
  };

  const submitComment = async () => {
    const body = draft.trim();
    if (body.length === 0 || submitting) return;
    setSubmitting(true);
    const result = await comment({ environmentId, input: { ...reference, body: draft } });
    setSubmitting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The comment could not be posted",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    setDraft("");
    onUpdated?.();
  };

  const save = async (patch: { title?: string; body?: string }) => {
    setSaving(true);
    const result = await update({ environmentId, input: { ...reference, ...patch } });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The issue could not be updated",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    setEditing(null);
    onUpdated?.();
  };

  const moveTo = async (state: string, closeReason?: string) => {
    if (changingState) return;
    setChangingState(true);
    const result = await setState({
      environmentId,
      input: { ...reference, state, ...(closeReason === undefined ? {} : { closeReason }) },
    });
    setChangingState(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The state could not be changed",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    onUpdated?.();
  };

  const updateMetadata = async (
    patch: { labels?: ReadonlyArray<IssueLabel>; assignees?: ReadonlyArray<IssueActor> },
    title: string,
  ) => {
    if (updatingMetadata) return;
    setUpdatingMetadata(true);
    const result = await update({
      environmentId,
      input: {
        ...reference,
        ...(patch.labels === undefined ? {} : { labels: patch.labels.map(issueLabelId) }),
        ...(patch.assignees === undefined
          ? {}
          : { assignees: patch.assignees.map(issueAssigneeId) }),
      },
    });
    setUpdatingMetadata(false);
    if (!reportIssueResult(result, title)) return;
    if (patch.labels !== undefined)
      setConfirmedLabels({
        base: detail,
        environmentId,
        kind: "labels",
        ids: patch.labels.map(issueLabelId),
        items: patch.labels,
      });
    if (patch.assignees !== undefined)
      setConfirmedAssignees({
        base: detail,
        environmentId,
        kind: "assignees",
        ids: patch.assignees.map(issueAssigneeId),
        items: patch.assignees,
      });
    onUpdated?.();
  };

  const stateControl: ReactNode = canSetState ? (
    <span className="flex shrink-0 items-center gap-1">
      {!needsStateCandidates && openingStates.length === 1 && closingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState}
          onClick={() => void moveTo(openingStates[0]!.id ?? openingStates[0]!.name)}
        >
          {issueStateActionLabel(openingStates[0]!)}
        </Button>
      ) : null}
      {!needsStateCandidates &&
      closingStates.length === 1 &&
      detail.capabilities.closeReasons.length === 0 &&
      openingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState}
          onClick={() => void moveTo(closingStates[0]!.id ?? closingStates[0]!.name)}
        >
          {issueStateActionLabel(closingStates[0]!)}
        </Button>
      ) : null}
      {needsStateCandidates ||
      (closingStates.length > 0 && detail.capabilities.closeReasons.length > 0) ||
      otherStates.length > 1 ? (
        <Menu open={stateMenuOpen} onOpenChange={setStateMenuOpen}>
          <MenuTrigger render={<Button size="xs" variant="outline" disabled={changingState} />}>
            {!needsStateCandidates && otherStates.every((state) => state.name === "closed")
              ? "Close"
              : "Change state"}
            <ChevronDownIcon aria-hidden className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            {needsStateCandidates && stateCandidates.error !== null ? (
              <>
                <MenuItem disabled>States could not be read. {stateCandidates.error}</MenuItem>
                <MenuItem closeOnClick={false} onClick={stateCandidates.refresh}>
                  Retry
                </MenuItem>
              </>
            ) : needsStateCandidates &&
              (stateCandidates.isPending || stateCandidates.data === null) ? (
              <MenuItem disabled>Loading states…</MenuItem>
            ) : needsStateCandidates && otherStates.length === 0 ? (
              <MenuItem disabled>No other states are available.</MenuItem>
            ) : null}
            {otherStates.flatMap((state) =>
              state.category === "closed" && detail.capabilities.closeReasons.length > 0
                ? detail.capabilities.closeReasons.map((reason) => (
                    <MenuItem
                      key={`${state.id ?? state.name}:${reason}`}
                      onClick={() => void moveTo(state.id ?? state.name, reason)}
                    >
                      {state.name === "closed" ? "Close" : state.name} as{" "}
                      {issueCloseReasonLabel(reason).toLowerCase()}
                    </MenuItem>
                  ))
                : [
                    <MenuItem
                      key={state.id ?? state.name}
                      onClick={() => void moveTo(state.id ?? state.name)}
                    >
                      {issueStateActionLabel(state)}
                    </MenuItem>,
                  ],
            )}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <PullRequestDetailTitleRow className="gap-2">
            <IssueStateGlyph state={detail.state} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              <tracker.Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
              {issueDisplayLabel(detail.scope, detail.displayKey)}
            </span>
            {detail.writable && canOperate ? (
              <Button
                size="xs"
                variant="outline"
                disabled={handoff.pending}
                onClick={() => void handoff.start(detail)}
              >
                <BotIcon aria-hidden className="size-3" />
                Solve
              </Button>
            ) : null}
            {stateControl}
            {threadRef ? (
              <IssueThreadLinkButton
                environmentId={environmentId}
                reference={{ ...reference, host: reference.host ?? detail.host }}
                url={detail.url}
                threadRef={threadRef}
              />
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh issue"
              disabled={detailQuery.isPending}
              onClick={detailQuery.refresh}
            >
              <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Open on ${tracker.providerName}`}
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </Button>
          </PullRequestDetailTitleRow>

          {editing === "title" ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = titleDraft.trim();
                if (next.length > 0 && next !== detail.title) void save({ title: next });
                else setEditing(null);
              }}
            >
              <Input
                autoFocus
                aria-label="Issue title"
                value={titleDraft}
                disabled={saving}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(null);
                }}
              />
              <Button type="submit" size="sm" disabled={saving}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="group flex items-start gap-1">
              <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
                {detail.title}
              </h2>
              {canEdit ? (
                <PullRequestEditButton
                  aria-label="Edit title"
                  onClick={() => {
                    setTitleDraft(detail.title);
                    setEditing("title");
                  }}
                />
              ) : null}
            </div>
          )}

          <PullRequestMetaLine className="text-xs text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} />
            <span>opened {formatRelativeTimeLabel(detail.createdAt)}</span>
            {detail.closedAt ? (
              <span>closed {formatRelativeTimeLabel(detail.closedAt)}</span>
            ) : null}
            {detail.writable ? null : <span>Read-only</span>}
          </PullRequestMetaLine>

          <div className="flex flex-wrap items-center gap-1.5">
            {labels.map((label) => (
              <PullRequestLabelChip key={issueLabelId(label)} label={label} />
            ))}
            {detail.capabilities.labels ? (
              <IssueLabelPicker
                environmentId={environmentId}
                source={reference}
                selected={labels}
                disabled={updatingMetadata}
                allowed={canLabel && detail.labelsTruncated !== true}
                disabledReason={
                  blocked ??
                  (detail.labelsTruncated === true
                    ? `Not every label is shown here, so change them on ${tracker.providerName}.`
                    : "Changing labels needs triage access on this tracker.")
                }
                onChange={(next) =>
                  void updateMetadata({ labels: next }, "Could not change labels")
                }
              />
            ) : null}
          </div>
          {detail.labelsTruncated === true ? (
            <IssueTruncatedNote
              text="Not every label is shown here."
              url={detail.url}
              providerName={tracker.providerName}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">Assignees</span>
            {assignees.length === 0 ? <span>none</span> : null}
            {assignees.map((actor) => (
              <PullRequestActorLabel key={issueAssigneeId(actor)} actor={actor} />
            ))}
            {detail.capabilities.assignees ? (
              <IssueAssigneePicker
                environmentId={environmentId}
                source={reference}
                selected={assignees}
                max={detail.capabilities.maxAssignees ?? 100}
                disabled={updatingMetadata}
                allowed={canAssign}
                disabledReason={
                  blocked ?? "Changing assignees needs triage access on this tracker."
                }
                onChange={(next) =>
                  void updateMetadata({ assignees: next }, "Could not change assignees")
                }
              />
            ) : null}
          </div>

          <section className="group flex flex-col gap-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-start gap-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">Description</span>
              {canEdit && editing !== "body" ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setEditing("body")}
                />
              ) : null}
            </div>
            {editing === "body" ? (
              <PullRequestMarkdownEditor
                value={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                label="Description"
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditing(null)}
              />
            ) : detail.body.trim().length > 0 ? (
              <PullRequestCommentBody
                text={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
              />
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
            {detail.reactions !== undefined ? (
              <IssueReactionBar
                key={issueEntryKey(detail)}
                reactions={detail.reactions}
                canReact={canReact}
                contents={detail.capabilities.reactionContents}
                environmentId={environmentId}
                reference={reference}
              />
            ) : null}
            {detail.reactionsTruncated === true ? (
              <IssueTruncatedNote
                text="Reaction details are limited."
                url={detail.url}
                providerName={tracker.providerName}
              />
            ) : null}
          </section>

          {detail.capabilities.events ? (
            <PullRequestDetailTabBar
              tabs={[
                { value: "summary" as const, label: "Summary" },
                { value: "history" as const, label: "History" },
              ]}
              value={activeTab}
              onValueChange={setTab}
            />
          ) : null}
          {activeTab === "history" ? (
            <IssueHistory environmentId={environmentId} reference={reference} />
          ) : (
            <>
              {detail.capabilities.subIssues ? (
                <IssueHierarchySection
                  key={issueEntryKey(detail)}
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  onSelectIssue={(ref, _displayKey, url) =>
                    useRightPanelStore.getState().openIssue(threadRef ?? ISSUES_PANEL_REF, {
                      ...ref,
                      host: ref.host ?? detail.host,
                      environmentId,
                      ...(url ? { url } : {}),
                    })
                  }
                  onCreateSubIssue={
                    detail.writable && canWrite && detail.capabilities.createSubIssue
                      ? () => setCreateSubIssue(true)
                      : null
                  }
                />
              ) : null}
              {detail.capabilities.linkedPullRequests &&
              (linkedPages.items.length > 0 || linkedPages.isPending || linkedPages.error) ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs text-muted-foreground">Linked pull requests</h3>
                  {linkedPages.items.map((link) => {
                    const target = linkedPullRequestTarget(link, reference);
                    return (
                      <LinkedPullRequestRow
                        key={link.url}
                        link={link}
                        onSelect={
                          onSelectPullRequest && target ? () => onSelectPullRequest(target) : null
                        }
                      />
                    );
                  })}
                  {linkedPages.error && linkedPages.items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{linkedPages.error}</p>
                  ) : null}
                  <IssueLoadMore page={linkedPages} label="Load more pull requests" />
                </section>
              ) : null}

              <section className="flex flex-col gap-3">
                <h3 className="text-xs text-muted-foreground">
                  Activity
                  {detail.commentCount !== null && detail.commentCount > 0
                    ? ` · ${detail.commentCount} ${detail.commentCount === 1 ? "comment" : "comments"}`
                    : ""}
                </h3>
                {detail.historyTruncated === true ? (
                  <IssueTruncatedNote
                    text="Some older activity is not shown here."
                    url={detail.url}
                    providerName={tracker.providerName}
                  />
                ) : null}
                {nextCursor !== null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder ? "Loading…" : "Load older comments"}
                  </Button>
                ) : null}
                {timeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>
                ) : null}
                {timeline.map((item) =>
                  item.kind === "comment" ? (
                    <article
                      key={`c:${issueEntryKey(detail)}:${item.comment.id}`}
                      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                    >
                      <IssueCommentContent
                        environmentId={environmentId}
                        reference={reference}
                        comment={item.comment}
                        cwd={cwd}
                        threadRef={threadRef}
                        canEdit={blocked === null && detail.capabilities.editComment === true}
                        onChanged={(body) => {
                          setOlder((held) =>
                            editRetainedIssueComment(
                              held,
                              issueEntryKey(detail),
                              item.comment.id,
                              body,
                            ),
                          );
                          onUpdated?.();
                        }}
                      />
                      {item.comment.reactions !== undefined ||
                      issueSupportsReactions(detail.capabilities, true) ? (
                        <IssueReactionBar
                          reactions={item.comment.reactions ?? []}
                          canReact={canReactToComment}
                          contents={detail.capabilities.reactionContents}
                          subjectId={item.comment.id}
                          environmentId={environmentId}
                          reference={reference}
                        />
                      ) : null}
                      {item.comment.reactionsTruncated === true ? (
                        <IssueTruncatedNote
                          text="Reaction details are limited."
                          url={item.comment.url ?? detail.url}
                          providerName={tracker.providerName}
                        />
                      ) : null}
                    </article>
                  ) : (
                    <PullRequestMetaLine
                      key={`e:${item.event.id}`}
                      className="px-1 text-xs text-muted-foreground"
                    >
                      <PullRequestActorLabel actor={item.event.actor} />
                      <span>{eventSentence(item.event)}</span>
                      <span>{formatRelativeTimeLabel(item.event.createdAt)}</span>
                    </PullRequestMetaLine>
                  ),
                )}
              </section>
            </>
          )}
        </div>
      </div>
      <IssueCreateDialog
        open={createSubIssue}
        onOpenChange={setCreateSubIssue}
        parent={{ key: detail.key, displayKey: detail.displayKey }}
        scopes={[
          {
            environmentId,
            projectTitle: detail.projectTitle,
            scope: reference,
            templates: detail.capabilities.templates,
            createIssueTypes: detail.capabilities.createIssueTypes,
            labels: detail.capabilities.labels,
            assignees: detail.capabilities.assignees,
            maxAssignees: detail.capabilities.maxAssignees,
          },
        ]}
        onCreated={(_scope, result) => {
          detailQuery.refresh();
          setCreateSubIssue(false);
          if (result.parentLinked === false)
            toastManager.add({
              type: "warning",
              title: "The issue was created, but its parent could not be set",
            });
        }}
      />
      {activeTab === "summary" && detail.capabilities.comment ? (
        <form
          className="flex flex-col gap-2 border-t border-border/60 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitComment();
          }}
        >
          <Textarea
            size="sm"
            aria-label="Add a comment"
            placeholder={canComment ? "Leave a comment" : (blocked ?? "You cannot comment here.")}
            value={draft}
            disabled={!canComment || submitting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitComment();
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={!canComment || submitting || draft.trim().length === 0}
            >
              <SendIcon aria-hidden className="size-3.5" />
              {submitting ? "Posting…" : "Comment"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
