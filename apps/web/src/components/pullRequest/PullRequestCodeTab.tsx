import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewDiffItem } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  PendingReviewCommentCard,
  ReviewCommentComposer,
  ReviewThreadCard,
} from "./PullRequestReviewAnnotation";
import { PullRequestReviewBar } from "./PullRequestReviewBar";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

/** Everything pinned to one line of one file: what is already there, and what is being added. */
interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

/**
 * Past this many files the viewer spends tens of seconds laying every one of them out before
 * the tab is usable, so a change this size opens folded and the reader unfolds what they came
 * for. A file already carrying a conversation is never folded — that is the part worth reading.
 */
const AUTO_COLLAPSE_FILE_COUNT = 20;

/** A group while it is still gathering what belongs on its line. */
interface MutableAnnotationGroup {
  readonly side: PullRequestDiffSide;
  readonly line: number;
  readonly threads: PullRequestReviewThread[];
  readonly pending: PendingReviewComment[];
  draft: boolean;
}

interface DraftAnchor {
  readonly fileKey: string;
  readonly path: string;
  /** What the file was called before the change, for the hosts that resolve a position by both. */
  readonly oldPath: string | null;
  readonly line: number;
  readonly side: PullRequestDiffSide;
}

/** The contract's sides named the way the diff viewer names them, and back again. */
function toViewerSide(side: PullRequestDiffSide) {
  return side === "left" ? ("deletions" as const) : ("additions" as const);
}

function fromViewerSide(side: string | undefined): PullRequestDiffSide {
  return side === "deletions" ? "left" : "right";
}

/**
 * The pull request's patch, with the review written against it. Conversations already on the
 * host sit under the line they were written on, and a new comment joins the review being
 * drafted rather than being posted as it is typed.
 */
export function PullRequestCodeTab({
  environmentId,
  reference,
  detail,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  onRefresh: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);

  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const referenceKey = pullRequestReviewKey(reference);
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
    setToggledFiles(new Set());
    setOrphansOpen(false);
  }, [referenceKey]);

  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({ environmentId, input: reference }),
  );
  const reviewKey = referenceKey;
  const pendingComments = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });

  const review = detail.capabilities.review;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        diffQuery.data?.patch,
        `pull-request:${reference.repository}#${reference.number}:${resolvedTheme}`,
      ),
    [diffQuery.data?.patch, reference.number, reference.repository, resolvedTheme],
  );
  const files = useMemo(
    () =>
      renderablePatch?.kind === "files"
        ? renderablePatch.files.toSorted((left, right) =>
            resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right)),
          )
        : [],
    [renderablePatch],
  );

  const items = useMemo<CodeViewDiffItem<ReviewAnnotationGroup>[]>(
    () =>
      files.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        const path = resolveFileDiffPath(fileDiff);
        // One annotation per line, so a line that already carries a conversation shows a new
        // comment underneath it rather than in place of it.
        const groups = new Map<string, MutableAnnotationGroup>();
        const groupAt = (side: PullRequestDiffSide, line: number) => {
          const key = `${side}:${line}`;
          const existing = groups.get(key);
          if (existing) return existing;
          const created: MutableAnnotationGroup = {
            side,
            line,
            threads: [],
            pending: [],
            draft: false,
          };
          groups.set(key, created);
          return created;
        };

        for (const thread of detail.reviewThreads) {
          if (thread.path !== path || thread.line === null) continue;
          groupAt(thread.side, thread.line).threads.push(thread);
        }
        for (const comment of pendingComments) {
          if (comment.path !== path) continue;
          groupAt(comment.side, comment.line).pending.push(comment);
        }
        if (draft?.fileKey === fileKey) groupAt(draft.side, draft.line).draft = true;

        // The reader's toggles are held as the difference from the default rather than as the
        // set itself, so a big diff can open folded without a seeding pass that would have to
        // race the patch arriving.
        const foldedByDefault = files.length > AUTO_COLLAPSE_FILE_COUNT && groups.size === 0;
        const collapsed = toggledFiles.has(fileKey) ? !foldedByDefault : foldedByDefault;

        const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
          side: toViewerSide(group.side),
          lineNumber: group.line,
          metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
        }));
        return {
          id: fileKey,
          type: "diff" as const,
          fileDiff,
          annotations,
          collapsed,
          // The viewer re-renders an item only when its version changes, so everything the
          // annotations show has to be part of it.
          version: fnv1a32(
            `${collapsed ? "1" : "0"}:${annotations
              .map(
                ({ side, lineNumber, metadata }) =>
                  `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                    .map((comment) => `${comment.id}:${comment.body}`)
                    .join(",")}:${metadata.threads
                    .map(
                      (thread) =>
                        `${thread.id}:${thread.isResolved ? "r" : ""}:${thread.comments.length}`,
                    )
                    .join(",")}`,
              )
              .join("|")}`,
          ),
        };
      }),
    [detail.reviewThreads, draft, files, pendingComments, toggledFiles],
  );
  const lineStat = useMemo(() => getDiffLineStat(files), [files]);

  const toggleFile = (fileKey: string) =>
    setToggledFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<ReviewAnnotationGroup> }) => {
      if (!range || !review.inlineComment) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
      if (!file) return;
      // A range collapses to its last line: only GitHub carries a multi-line comment, and one
      // that silently lost its first line on the other hosts would be worse than one line.
      const path = resolveFileDiffPath(file);
      const previousPath = resolveFileDiffPreviousPath(file);
      setDraft({
        fileKey: item.id,
        path,
        oldPath: previousPath === path ? null : previousPath,
        line: range.end,
        side: fromViewerSide(range.endSide ?? range.side),
      });
    },
    [files, review.inlineComment],
  );

  const runThreadCommand = async (label: string, run: () => Promise<{ readonly _tag: string }>) => {
    if (threadPending) return;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return;
    }
    onRefresh();
  };

  // A conversation is the same card wired to the same commands whether it sits on its line or
  // was stranded off the diff; only where it is drawn differs.
  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      key={thread.id}
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      canReply={review.reply}
      canResolve={review.resolve}
      pending={threadPending}
      onReply={(body) =>
        void runThreadCommand("Reply could not be posted", () =>
          replyToThread({
            environmentId,
            input: { ...reference, threadId: thread.id, body },
          }),
        )
      }
      onToggleResolved={() =>
        void runThreadCommand("The conversation could not be updated", () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
    />
  );

  if (diffQuery.isPending && !diffQuery.data) {
    return (
      <div className="space-y-2 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  /**
   * The review bar belongs to the pull request, not to the patch: a change whose diff cannot
   * be structured — or read at all — is still one a reviewer can approve or reject, so it
   * survives every branch below.
   */
  const reviewBar = (
    <PullRequestReviewBar
      environmentId={environmentId}
      reference={reference}
      verdicts={review.verdicts}
      onSubmitted={onRefresh}
    />
  );
  const withReviewBar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      {reviewBar}
    </div>
  );

  if (diffQuery.error) {
    return withReviewBar(<p className="p-5 text-sm text-muted-foreground">{diffQuery.error}</p>);
  }

  // A patch the viewer cannot structure (binary, or a format it does not parse) still has to
  // be readable, so it falls back to the raw text rather than an empty tab.
  if (renderablePatch?.kind === "raw") {
    return withReviewBar(
      <div className="space-y-2 p-5">
        <p className="text-xs text-muted-foreground">{renderablePatch.reason}</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">
          {renderablePatch.text}
        </pre>
      </div>,
    );
  }

  if (items.length === 0) {
    return withReviewBar(
      <p className="p-5 text-sm text-muted-foreground">This pull request has no file changes.</p>,
    );
  }

  const orphanThreads = detail.reviewThreads.filter(
    (thread) =>
      thread.line === null || !files.some((file) => resolveFileDiffPath(file) === thread.path),
  );
  // A file carrying five stranded conversations should read as that file once rather than as
  // five copies of its path.
  const orphanFiles = new Map<string, PullRequestReviewThread[]>();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.push(thread);
    else orphanFiles.set(thread.path, [thread]);
  }

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 flex-col">
        <PullRequestMetaLine className="shrink-0 border-b border-border/60 px-5 py-2 text-xs text-muted-foreground">
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <PullRequestDiffStat additions={lineStat.additions} deletions={lineStat.deletions} />
          {diffQuery.data?.truncated ? <span>diff truncated</span> : null}
          {/* Otherwise a wall of folded headers reads as a diff that failed to load. */}
          {files.length > AUTO_COLLAPSE_FILE_COUNT ? (
            <span>large diff, files start folded</span>
          ) : null}
          {review.inlineComment ? <span>select lines to comment</span> : null}
        </PullRequestMetaLine>
        {/* Above the code, closed, and counted: these belong to the change rather than to any
            line of it, and in the stream they read as cards dropped into the patch. */}
        {orphanFiles.size > 0 ? (
          <Collapsible
            className="shrink-0 border-b border-border/60"
            open={orphansOpen}
            onOpenChange={setOrphansOpen}
          >
            {/* Still a heading, so the section keeps its place in a screen reader's outline;
                the count is spelled out there rather than left as a bare number. */}
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-5 py-2 text-left text-xs text-muted-foreground">
                <span>Conversations not on the current diff</span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", orphansOpen && "rotate-90")}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length}
                </span>
                <span className="sr-only">
                  {orphanThreads.length === 1
                    ? "1 conversation"
                    : `${orphanThreads.length} conversations`}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
              {/* Capped: opened on a change with dozens of them, this would otherwise leave no
                  room for the diff it sits above. */}
              <div className="max-h-64 space-y-3 overflow-auto px-5 pb-3">
                {[...orphanFiles].map(([path, threads]) => (
                  <div key={path}>
                    <p className="truncate px-3 text-xs text-muted-foreground" title={path}>
                      {path}
                    </p>
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-xs text-muted-foreground">Line {thread.line}</p>
                          )}
                          {renderThreadCard(thread)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
        {/* The viewer virtualizes against the element it is told is scrolling and places its
            rows absolutely, so it has to own that element — the thread diff panel hands it the
            same one. Scrolling from a parent instead leaves it painting over its neighbours. */}
        <CodeView<ReviewAnnotationGroup>
          className="diff-render-surface min-h-0 flex-1 overflow-auto"
          items={items}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          options={{
            diffStyle: "unified",
            lineDiffType: "none",
            overflow: "wrap",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            stickyHeaders: true,
            itemMetrics: { diffHeaderHeight: 33 },
            layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
            enableGutterUtility: review.inlineComment && draft === null,
            enableLineSelection: review.inlineComment && draft === null,
            // Two gestures reach the same place: dragging the line numbers selects a range,
            // and the gutter's own button comments on the one line it sits on. They are
            // separate callbacks in the viewer, so a reader who only ever presses the button
            // gets nothing unless both are wired.
            onGutterUtilityClick: beginComment,
            onLineSelectionEnd: beginComment,
          }}
          renderHeaderPrefix={(item) => {
            // The item the viewer is drawing already carries the state the memo settled on,
            // so the chevron follows it rather than recomputing the default here.
            const collapsed = item.collapsed === true;
            return (
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand diff" : "Collapse diff"}
                className={cn(
                  "mr-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleFile(item.id);
                }}
              >
                {collapsed ? (
                  <ChevronRightIcon className="size-4" />
                ) : (
                  <ChevronDownIcon className="size-4" />
                )}
              </button>
            );
          }}
          renderAnnotation={(annotation) => (
            <div className="py-1">
              {annotation.metadata.threads.map(renderThreadCard)}
              {annotation.metadata.pending.map((comment) => (
                <PendingReviewCommentCard
                  key={comment.id}
                  comment={comment}
                  onRemove={() => removeComment(reviewKey, comment.id)}
                />
              ))}
              {annotation.metadata.draft && draft ? (
                <ReviewCommentComposer
                  lineLabel={`${draft.path}:${draft.line}`}
                  pending={false}
                  onCancel={() => {
                    setDraft(null);
                    setSelectedLines(null);
                  }}
                  onSubmit={(body) => {
                    addComment(reviewKey, {
                      id: nextPendingReviewCommentId(),
                      path: draft.path,
                      ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
                      line: draft.line,
                      side: draft.side,
                      body,
                    });
                    setDraft(null);
                    setSelectedLines(null);
                  }}
                />
              ) : null}
            </div>
          )}
        />
        {reviewBar}
      </div>
    </DiffWorkerPoolProvider>
  );
}

export default PullRequestCodeTab;
