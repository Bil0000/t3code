import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewDiffItem } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  PendingReviewCommentCard,
  ReviewCommentComposer,
  ReviewThreadCard,
} from "./PullRequestReviewAnnotation";
import { PullRequestReviewBar } from "./PullRequestReviewBar";
import { isLineInFileDiff } from "./pullRequestDiff.logic";
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

/** One answer from the host: a whole number of files, and where the next one carries on. */
interface DiffSlice {
  /** What was asked for, null being the first slice. Identifies the slice among the loaded ones. */
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** Nothing loaded yet, as one identity, so the memos below do not see a new array every render. */
const NO_SLICES: ReadonlyArray<DiffSlice> = [];

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
 * Whether the viewer draws this line at all. A line counts the new file on the right and the old
 * one on the left, and each hunk covers one run of each; a line outside every run — a
 * conversation the host could not mark outdated, or one under a hunk it withheld — has no row to
 * be pinned to, however much its file looks like a match.
 */
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
  // Which pull request the slices belong to travels with them, so a render taken before the
  // reset below cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });
  const parseCache = useRef(new Map<string, RenderablePatch>());

  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const referenceKey = pullRequestReviewKey(reference);
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
    setToggledFiles(new Set());
    setOrphansOpen(false);
    setSliceState({ key: referenceKey, cursor: null, slices: NO_SLICES });
    parseCache.current.clear();
  }, [referenceKey]);

  const loadedSlices = sliceState.key === referenceKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === referenceKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: cursor === null ? reference : { ...reference, cursor },
    }),
  );
  // Each answer is kept as its own slice. Concatenating the patches and re-parsing the growing
  // text would cost more with every slice, which is the wall the slicing exists to remove.
  useEffect(() => {
    const data = diffQuery.data;
    if (data === null) return;
    setSliceState((previous) => {
      const slices = previous.key === referenceKey ? previous.slices : NO_SLICES;
      if (slices.some((slice) => slice.cursor === cursor)) return previous;
      return {
        key: referenceKey,
        cursor,
        slices: [
          ...slices,
          {
            cursor,
            patch: data.patch,
            truncated: data.truncated,
            nextCursor: data.nextCursor,
          },
        ],
      };
    });
  }, [cursor, diffQuery.data, referenceKey]);
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
  // Every slice is parsed on its own and the result held, so a slice arriving costs one parse
  // rather than one per slice already on screen. Its cache key carries the theme, which is what
  // the tokenizer caches against, so a theme change is still a fresh parse.
  const parsedSlices = useMemo(
    () =>
      loadedSlices.map((slice) => {
        const cacheKey = `pull-request:${referenceKey}:${resolvedTheme}:${slice.cursor ?? "first"}`;
        const cached = parseCache.current.get(cacheKey);
        if (cached) return cached;
        const parsed = getRenderablePatch(slice.patch, cacheKey);
        if (parsed) parseCache.current.set(cacheKey, parsed);
        return parsed;
      }),
    [loadedSlices, referenceKey, resolvedTheme],
  );
  // Sorted within a slice rather than across them: sorting the accumulated set would let a late
  // slice push a file the reader is part way through further down the page.
  const files = useMemo(
    () =>
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files"
          ? parsed.files.toSorted((left, right) =>
              resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right)),
            )
          : [],
      ),
    [parsedSlices],
  );
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  /**
   * A change the host had to slice is a large one whatever the count in hand says, so the
   * folding default is settled by the first answer. Both halves only ever go from false to true:
   * a default that flipped mid-scroll would refold the file the reader had just opened.
   */
  const largeDiff =
    files.length > AUTO_COLLAPSE_FILE_COUNT ||
    loadedSlices.some((slice) => slice.nextCursor !== null);
  // What a slice withheld: the host declining to inline part of it, or a patch the viewer could
  // not structure and so dropped. Neither says anything about there being more to fetch.
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");

  // Placing a conversation takes more than its file being in the diff: its line has to fall
  // inside a hunk that was rendered. One that does not is drawn nowhere, so it belongs in the
  // off-diff list rather than disappearing between the two.
  const placedThreadIds = useMemo(() => {
    const placed = new Set<string>();
    for (const file of files) {
      const path = resolveFileDiffPath(file);
      for (const thread of detail.reviewThreads) {
        if (
          thread.path === path &&
          thread.line !== null &&
          isLineInFileDiff(file, thread.side, thread.line)
        ) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  }, [detail.reviewThreads, files]);

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

        let carriesConversation = false;
        for (const thread of detail.reviewThreads) {
          if (thread.path !== path || thread.line === null) continue;
          if (!placedThreadIds.has(thread.id)) continue;
          carriesConversation = true;
          groupAt(thread.side, thread.line).threads.push(thread);
        }
        for (const comment of pendingComments) {
          if (comment.path !== path) continue;
          groupAt(comment.side, comment.line).pending.push(comment);
        }
        if (draft?.fileKey === fileKey) groupAt(draft.side, draft.line).draft = true;

        // The reader's toggles are held as the difference from the default rather than as the
        // set itself, so a big diff can open folded without a seeding pass that would have to
        // race the patch arriving. That only works while the default holds still: it is decided
        // by what the host already has, never by a comment being written, because a default that
        // moved would invert the toggle and fold the very file the reader opened to write in.
        const foldedByDefault = largeDiff && !carriesConversation;
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
    [detail.reviewThreads, draft, files, largeDiff, pendingComments, placedThreadIds, toggledFiles],
  );
  const lineStat = useMemo(() => getDiffLineStat(files), [files]);

  // The sentinel is held as state rather than a ref because the viewer mounts its own footer:
  // an effect reading a ref could run before that node exists and would never arm the observer.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    // A failed slice must stop the observer. The files already loaded keep the sentinel on
    // screen, so re-arming it after a failure would ask for the same slice again, forever.
    if (
      sentinel === null ||
      nextCursor === null ||
      nextCursor === cursor ||
      diffQuery.isPending ||
      diffQuery.error !== null
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) {
          setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
        }
      },
      // Start the next slice slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, diffQuery.error, diffQuery.isPending, nextCursor, sentinel]);

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

  const runThreadCommand = async (
    label: string,
    run: () => Promise<{ readonly _tag: string }>,
  ): Promise<boolean> => {
    if (threadPending) return false;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return false;
    }
    onRefresh();
    return true;
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
        runThreadCommand("Reply could not be posted", () =>
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

  if (diffQuery.isPending && loadedSlices.length === 0) {
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

  // A slice that fails once there are files on screen is reported at the end of them instead:
  // the diff already read is worth more than the error that stopped it growing.
  if (diffQuery.error && loadedSlices.length === 0) {
    return withReviewBar(<p className="p-5 text-sm text-muted-foreground">{diffQuery.error}</p>);
  }

  // A patch the viewer cannot structure (binary, or a format it does not parse) still has to
  // be readable, so it falls back to the raw text rather than an empty tab. Only once the diff
  // is whole: returning here while a cursor is outstanding would take the sentinel off screen
  // and end the walk, leaving the rest of the change unasked for.
  const rawSlice = parsedSlices.find((parsed) => parsed?.kind === "raw");
  if (files.length === 0 && nextCursor === null && rawSlice?.kind === "raw") {
    return withReviewBar(
      <div className="space-y-2 p-5">
        <p className="text-xs text-muted-foreground">{rawSlice.reason}</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">{rawSlice.text}</pre>
      </div>,
    );
  }

  if (items.length === 0 && nextCursor === null) {
    return withReviewBar(
      <p className="p-5 text-sm text-muted-foreground">This pull request has no file changes.</p>,
    );
  }

  const orphanThreads = detail.reviewThreads.filter((thread) => !placedThreadIds.has(thread.id));
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
          {/* The count is what is in hand rather than what the change contains: on a diff that
              arrives in slices it keeps growing, and only the last one settles it. */}
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
            {nextCursor !== null ? " so far" : loadedSlices.length > 1 ? ", all loaded" : ""}
          </span>
          <PullRequestDiffStat additions={lineStat.additions} deletions={lineStat.deletions} />
          {withheldContent ? <span>some content not shown</span> : null}
          {/* Otherwise a wall of folded headers reads as a diff that failed to load. */}
          {largeDiff ? <span>large diff, files start folded</span> : null}
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
                {/* While slices are still arriving a conversation may simply belong to a file
                    that has not landed yet, which is not the same as being off the diff. */}
                <span>
                  {nextCursor === null
                    ? "Conversations not on the current diff"
                    : "Conversations not on the diff loaded so far"}
                </span>
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
          // The viewer owns the scroll container, so the sentinel that asks for the next slice
          // has to live inside it — at the end of the files, where reaching it means the reader
          // is running out of diff.
          renderCodeViewFooter={() =>
            // Only while something is still owed. A finished diff whose query fails on a later
            // refresh — a reconnect re-runs every one of them — is whole on screen already, and
            // saying otherwise sends the reader looking for files that are all there.
            nextCursor === null ? null : (
              <div
                ref={setSentinel}
                className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
              >
                {diffQuery.error !== null ? (
                  <>
                    <span>The rest of this diff could not be loaded.</span>
                    <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
                      Retry
                    </Button>
                  </>
                ) : diffQuery.isPending ? (
                  "Loading more files..."
                ) : null}
              </div>
            )
          }
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
