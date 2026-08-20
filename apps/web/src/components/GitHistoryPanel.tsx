import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitCommitChangedFile, GitHistoryCommit } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { FileIcon, GitBranchIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { layoutGitHistoryGraph } from "../lib/gitHistoryGraph";
import { cn } from "../lib/utils";
import { useClientSettings } from "../hooks/useSettings";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentConnectionState } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { CommitDetailsPane } from "./git-history/GitHistoryCommitDetails";
import { CommitDiffView } from "./git-history/GitHistoryCommitDiff";
import {
  CommitRow,
  gitHistoryRowHeight,
  currentHeadHash,
  firstParentHashes,
  graphColumnWidth,
  queryErrorMessage,
} from "./git-history/GitHistoryCommitList";
import { PaneResizeHandle } from "./git-history/GitHistoryPaneResizeHandle";
import { GitRefsPane } from "./git-history/GitHistoryRefsPane";
import type {
  CommitRefKind,
  GitHistoryRow,
  RefTreeProps,
} from "./git-history/GitHistoryVisualTypes";
import { useGitHistoryRefs } from "./git-history/useGitHistoryRefs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;
const INITIAL_CURSORS = [undefined] as const;
const WIDE_HISTORY_LAYOUT_MIN_WIDTH = 1120;
const REFS_PANE_MIN_WIDTH = 176;
const REFS_PANE_MAX_WIDTH = 480;
const DETAILS_PANE_MIN_WIDTH = 256;
const DETAILS_PANE_MAX_WIDTH = 720;
const HISTORY_CONTENT_MIN_WIDTH = 320;
const PANE_RESIZE_HANDLE_TOTAL_WIDTH = 16;

function isHistorySnapshotExpired(cause: Cause.Cause<unknown>): boolean {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  const squashed = Cause.squash(cause);
  return (
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "VcsSnapshotExpiredError") ||
    (typeof squashed === "object" &&
      squashed !== null &&
      "_tag" in squashed &&
      squashed._tag === "VcsSnapshotExpiredError")
  );
}

interface GitHistoryPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  issueUrlPrefix?: string;
  active?: boolean;
}

export function isWideHistoryLayout(width: number): boolean {
  return width >= WIDE_HISTORY_LAYOUT_MIN_WIDTH;
}

export function appendCommitFilesPage(
  current: ReadonlyArray<GitCommitChangedFile>,
  page: ReadonlyArray<GitCommitChangedFile>,
): ReadonlyArray<GitCommitChangedFile> {
  return [...current, ...page].slice(0, 2_000);
}

export function nextCommitFilesCursor(nextCursor: string | null): string | undefined {
  return nextCursor ?? undefined;
}

export function nextCommitFilesRecoveryGeneration(input: {
  readonly errorCause: Cause.Cause<unknown> | null;
  readonly generation: number;
  readonly recoveryInFlight: boolean;
}): number | null {
  return input.errorCause !== null &&
    isHistorySnapshotExpired(input.errorCause) &&
    !input.recoveryInFlight
    ? input.generation + 1
    : null;
}

function clampHistoryPaneWidths(input: {
  readonly panelWidth: number;
  readonly refsPaneWidth: number;
  readonly detailsPaneWidth: number;
}): { readonly refsPaneWidth: number; readonly detailsPaneWidth: number } {
  const maxSidePaneWidth = Math.max(
    REFS_PANE_MIN_WIDTH + DETAILS_PANE_MIN_WIDTH,
    input.panelWidth - HISTORY_CONTENT_MIN_WIDTH - PANE_RESIZE_HANDLE_TOTAL_WIDTH,
  );
  const refsPaneWidth = Math.min(
    Math.min(REFS_PANE_MAX_WIDTH, maxSidePaneWidth - DETAILS_PANE_MIN_WIDTH),
    Math.max(REFS_PANE_MIN_WIDTH, input.refsPaneWidth),
  );
  const detailsPaneWidth = Math.min(
    Math.min(DETAILS_PANE_MAX_WIDTH, maxSidePaneWidth - refsPaneWidth),
    Math.max(DETAILS_PANE_MIN_WIDTH, input.detailsPaneWidth),
  );
  return { refsPaneWidth, detailsPaneWidth };
}

function useHistoryPanelLayout(
  panelRef: RefObject<HTMLElement | null>,
  onResize: (width: number) => void,
): {
  readonly isWide: boolean;
  readonly widthRef: RefObject<number>;
} {
  const widthRef = useRef(Number.POSITIVE_INFINITY);
  const onResizeRef = useRef(onResize);
  const [isWide, setIsWide] = useState(true);
  onResizeRef.current = onResize;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      const nextIsWide = isWideHistoryLayout(width);
      if (nextIsWide !== isWideHistoryLayout(widthRef.current)) setIsWide(nextIsWide);
      widthRef.current = width;
      onResizeRef.current(width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef]);

  return { isWide, widthRef };
}

export default function GitHistoryPanel(props: GitHistoryPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const refsPaneWidthRef = useRef(256);
  const detailsPaneWidthRef = useRef(384);
  const interfaceFontSize = useClientSettings((settings) => settings.fontSizeInterface);
  const rowHeight = gitHistoryRowHeight(interfaceFontSize);
  const baseTargetKey = `${props.environmentId}:${props.cwd}`;
  const connection = useEnvironmentConnectionState(props.environmentId).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [refsPaneWidth, setRefsPaneWidth] = useState(256);
  const [detailsPaneWidth, setDetailsPaneWidth] = useState(384);
  const applyPaneWidths = (widths: {
    readonly refsPaneWidth: number;
    readonly detailsPaneWidth: number;
  }) => {
    if (widths.refsPaneWidth !== refsPaneWidthRef.current) {
      refsPaneWidthRef.current = widths.refsPaneWidth;
      setRefsPaneWidth(widths.refsPaneWidth);
    }
    if (widths.detailsPaneWidth !== detailsPaneWidthRef.current) {
      detailsPaneWidthRef.current = widths.detailsPaneWidth;
      setDetailsPaneWidth(widths.detailsPaneWidth);
    }
  };
  const { isWide: isWideLayout, widthRef: panelWidthRef } = useHistoryPanelLayout(
    panelRef,
    (panelWidth) => {
      if (!isWideHistoryLayout(panelWidth)) return;
      applyPaneWidths(
        clampHistoryPaneWidths({
          panelWidth,
          refsPaneWidth: refsPaneWidthRef.current,
          detailsPaneWidth: detailsPaneWidthRef.current,
        }),
      );
    },
  );
  const [historyQueryGeneration, setHistoryQueryGeneration] = useState(0);
  const vcsHistoryRevision = useAtomValue(
    vcsEnvironment.historyRevisionAtom({ environmentId: props.environmentId, cwd: props.cwd }),
  );
  const historyRefs = useGitHistoryRefs(props.environmentId, props.cwd, vcsHistoryRevision);
  const { selectedRevision } = historyRefs;
  const targetKey = `${baseTargetKey}:${selectedRevision?.revision ?? "all"}:${vcsHistoryRevision}:${connectionGeneration}`;
  const [pagination, setPagination] = useState<{
    targetKey: string;
    cursors: ReadonlyArray<string | undefined>;
  }>({ targetKey, cursors: INITIAL_CURSORS });
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_CURSORS;
  const pageAtoms = useMemo(
    () =>
      selectedRevision === undefined
        ? []
        : cursors.map((cursor) =>
            vcsEnvironment.getHistory({
              environmentId: props.environmentId,
              input: {
                cwd: props.cwd,
                queryGeneration: historyQueryGeneration + vcsHistoryRevision,
                ...(selectedRevision === null ? {} : { revision: selectedRevision.revision }),
                ...(cursor === undefined ? {} : { cursor }),
                limit: HISTORY_PAGE_SIZE,
              },
            }),
          ),
    [
      connectionGeneration,
      cursors,
      historyQueryGeneration,
      props.cwd,
      props.environmentId,
      selectedRevision,
      vcsHistoryRevision,
    ],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-history-pages:${targetKey}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = useMemo(
    () =>
      results.flatMap((result) => {
        const value = Option.getOrNull(AsyncResult.value(result));
        return value === null ? [] : [value];
      }),
    [results],
  );
  const failed = results.find((result) => result._tag === "Failure");
  const error = failed?._tag === "Failure" ? queryErrorMessage(failed.cause) : null;
  const recoveredSnapshot = useRef<{
    readonly targetKey: string;
    readonly generation: number;
  } | null>(null);
  useEffect(() => {
    if (recoveredSnapshot.current?.targetKey !== targetKey) recoveredSnapshot.current = null;
    if (
      recoveredSnapshot.current?.generation === historyQueryGeneration &&
      failed === undefined &&
      values.length > 0
    ) {
      recoveredSnapshot.current = null;
      return;
    }
    if (
      failed?._tag === "Failure" &&
      isHistorySnapshotExpired(failed.cause) &&
      recoveredSnapshot.current?.generation !== historyQueryGeneration
    ) {
      recoveredSnapshot.current = { targetKey, generation: historyQueryGeneration + 1 };
      setPagination({ targetKey, cursors: INITIAL_CURSORS });
      setHistoryQueryGeneration((generation) => generation + 1);
    }
  }, [failed, historyQueryGeneration, targetKey, values.length]);
  const isPending = selectedRevision === undefined || results.some((result) => result.waiting);
  const isInitialLoad = selectedRevision === undefined || (values.length === 0 && isPending);
  const history = useMemo(() => {
    const commitsByHash = new Map<string, GitHistoryCommit>();
    for (const value of values) {
      for (const commit of value.commits) {
        if (!commitsByHash.has(commit.hash)) commitsByHash.set(commit.hash, commit);
      }
    }
    return [...commitsByHash.values()];
  }, [values]);
  const isRepo = values[0]?.isRepo ?? true;
  const lastPage = values.at(-1) ?? null;
  const nextCursor = lastPage?.nextCursor ?? null;
  const hasMoreFromServer = lastPage?.hasMore === true && nextCursor !== null;
  const historyLimitReached = cursors.length >= MAX_HISTORY_PAGES;
  const hasMore = hasMoreFromServer && !historyLimitReached;
  const isFetchingNextPage = results.at(-1)?.waiting === true && values.length > 0;
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const deferredFilter = useDeferredValue(normalizedFilter);
  const activeFilter = normalizedFilter.length === 0 ? "" : deferredFilter;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"refs" | "details" | null>(null);
  const previousMobilePane = useRef<typeof mobilePane>(null);
  const branchesButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [commitDiffRequest, setCommitDiffRequest] = useState<{
    hash: string;
    filePath?: string;
  } | null>(null);
  const commitDetailsQuery = useEnvironmentQuery(
    selectedHash === null
      ? null
      : vcsEnvironment.getCommitDetails({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, hash: selectedHash, queryGeneration: vcsHistoryRevision },
        }),
  );
  const selectedCommitDetails = commitDetailsQuery.data?.commit ?? null;
  const [commitFilesCursor, setCommitFilesCursor] = useState<string | undefined>(undefined);
  const [commitFiles, setCommitFiles] = useState<ReadonlyArray<GitCommitChangedFile>>([]);
  const [commitFilesNextCursor, setCommitFilesNextCursor] = useState<string | null>(null);
  const [commitFilesHasMore, setCommitFilesHasMore] = useState(false);
  const [commitFilesCapped, setCommitFilesCapped] = useState(false);
  const [commitFilesQueryGeneration, setCommitFilesQueryGeneration] = useState(0);
  const receivedCommitFilesPages = useRef(new Set<string>());
  const commitFilesRecoveryInFlight = useRef(false);
  useEffect(() => {
    setCommitFilesCursor(undefined);
    setCommitFiles([]);
    setCommitFilesNextCursor(null);
    setCommitFilesHasMore(false);
    setCommitFilesCapped(false);
    commitFilesRecoveryInFlight.current = false;
    receivedCommitFilesPages.current.clear();
  }, [props.cwd, props.environmentId, selectedHash, vcsHistoryRevision]);
  const commitFilesQuery = useEnvironmentQuery(
    selectedHash === null
      ? null
      : vcsEnvironment.listCommitFiles({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            hash: selectedHash,
            limit: 100,
            queryGeneration: commitFilesQueryGeneration + vcsHistoryRevision,
            ...(commitFilesCursor ? { cursor: commitFilesCursor } : {}),
          },
        }),
  );
  useEffect(() => {
    const page = commitFilesQuery.data;
    if (!page || selectedHash === null) return;
    const pageKey = `${selectedHash}:${commitFilesCursor ?? "first"}:${page.nextCursor ?? "last"}`;
    if (receivedCommitFilesPages.current.has(pageKey)) return;
    receivedCommitFilesPages.current.add(pageKey);
    setCommitFiles((current) => appendCommitFilesPage(current, page.files));
    setCommitFilesHasMore(page.hasMore);
    setCommitFilesCapped(page.capped);
    setCommitFilesNextCursor(page.nextCursor);
    if (commitFilesCursor === undefined) commitFilesRecoveryInFlight.current = false;
  }, [commitFilesCursor, commitFilesQuery.data, selectedHash]);
  useEffect(() => {
    const recoveryGeneration = nextCommitFilesRecoveryGeneration({
      errorCause: commitFilesQuery.error === null ? null : commitFilesQuery.errorCause,
      generation: commitFilesQueryGeneration,
      recoveryInFlight: commitFilesRecoveryInFlight.current,
    });
    if (recoveryGeneration !== null) {
      receivedCommitFilesPages.current.clear();
      setCommitFiles([]);
      setCommitFilesCursor(undefined);
      setCommitFilesNextCursor(null);
      setCommitFilesHasMore(false);
      setCommitFilesCapped(false);
      commitFilesRecoveryInFlight.current = true;
      setCommitFilesQueryGeneration(recoveryGeneration);
    }
  }, [commitFilesQuery.error, commitFilesQuery.errorCause, commitFilesQueryGeneration]);
  const selectedCommitFiles = commitFiles;
  const loadMoreCommitFiles = () => {
    const cursor = nextCommitFilesCursor(commitFilesNextCursor);
    if (cursor) setCommitFilesCursor(cursor);
  };
  const commitDiffQuery = useEnvironmentQuery(
    commitDiffRequest === null
      ? null
      : vcsEnvironment.getCommitDiff({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            hash: commitDiffRequest.hash,
            queryGeneration: vcsHistoryRevision,
            ...(commitDiffRequest.filePath ? { filePath: commitDiffRequest.filePath } : {}),
          },
        }),
  );
  const {
    currentRef = null,
    expandedRefKeys,
    hasMoreRefs,
    isFetchingMoreRefs,
    isRefSnapshotComplete,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs,
    onRetryRefs,
    refreshRefs,
    refPaginationError,
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs: selectAllHistoryRefs,
    selectRef: selectHistoryRef,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleRefKey,
  } = historyRefs;
  const commitRefKinds = useMemo(() => {
    const kinds = new Map<string, CommitRefKind>();
    for (const ref of localRefs) kinds.set(ref.name, "local");
    for (const ref of remoteRefs) kinds.set(ref.name, "remote");
    for (const ref of tagRefs) kinds.set(ref.name, "tag");
    return kinds;
  }, [localRefs, remoteRefs, tagRefs]);
  const selectRef = useCallback(
    (label: string, revision: string) => {
      selectHistoryRef(label, revision);
      setMobilePane(null);
    },
    [selectHistoryRef],
  );
  const selectAllRefs = useCallback(() => {
    selectAllHistoryRefs();
    setMobilePane(null);
  }, [selectAllHistoryRefs]);
  const sharedRefTreeProps = {
    filterActive: normalizedRefFilter.length > 0,
    expanded: expandedRefKeys,
    selectedRevision: selectedRevision?.revision ?? null,
    onToggle: toggleRefKey,
    onSelect: selectRef,
  } satisfies Omit<RefTreeProps, "nodes" | "namespace" | "section">;
  const refPaneProps = {
    refFilter,
    onRefFilterChange: setRefFilter,
    selectedRevision: selectedRevision ?? null,
    onSelectAll: selectAllRefs,
    currentRef,
    onSelectRef: selectRef,
    normalizedRefFilter,
    localRefTree,
    remoteRefTree,
    tagRefTree,
    expandedRefKeys,
    onToggleRefKey: toggleRefKey,
    sharedRefTreeProps,
    hasMoreRefs,
    isFetchingMoreRefs,
    isRefSnapshotComplete,
    onLoadMoreRefs,
    onRetryRefs,
    refPaginationError,
  } satisfies Omit<ComponentProps<typeof GitRefsPane>, "className" | "id" | "onClose">;

  useEffect(() => {
    setPagination({ targetKey, cursors: INITIAL_CURSORS });
    setFilter("");
    setSelectedHash(null);
    setCommitDiffRequest(null);
    setMobilePane((pane) => (pane === "details" ? null : pane));
  }, [targetKey]);

  useEffect(() => {
    if (isWideLayout) setMobilePane(null);
  }, [isWideLayout]);

  const headHash = useMemo(() => currentHeadHash(history), [history]);
  const primaryHashes = useMemo(() => firstParentHashes(history, headHash), [headHash, history]);
  const filteredHistory = useMemo(() => {
    const query = activeFilter;
    return history.filter(
      (commit) =>
        query.length === 0 ||
        `${commit.hash} ${commit.subject} ${commit.authorName} ${commit.refs.join(" ")}`
          .toLocaleLowerCase()
          .includes(query),
    );
  }, [activeFilter, history]);
  const { laneCount, rows: graphRows } = useMemo(
    () =>
      layoutGitHistoryGraph(filteredHistory, {
        includeMissingParents: activeFilter.length === 0,
        ...(headHash ? { primaryHash: headHash } : {}),
        primaryHashes,
      }),
    [activeFilter, filteredHistory, headHash, primaryHashes],
  );
  const graphByHash = useMemo(() => new Map(graphRows.map((row) => [row.hash, row])), [graphRows]);
  const filteredRows = useMemo(() => {
    return filteredHistory.flatMap((commit) => {
      const graph = graphByHash.get(commit.hash);
      return graph ? [{ commit, graph }] : [];
    });
  }, [filteredHistory, graphByHash]);

  useEffect(() => {
    if (selectedHash !== null && !history.some((commit) => commit.hash === selectedHash)) {
      setSelectedHash(null);
    }
  }, [history, selectedHash]);

  useEffect(() => {
    if (props.active === false) setMobilePane(null);
  }, [props.active]);

  useEffect(() => {
    const previous = previousMobilePane.current;
    previousMobilePane.current = mobilePane;
    if (mobilePane !== null || previous === null) return;
    (previous === "refs" ? branchesButtonRef.current : detailsButtonRef.current)?.focus();
  }, [mobilePane]);

  const refresh = useCallback(() => {
    setHistoryQueryGeneration((generation) => generation + 1);
    setPagination({ targetKey, cursors: INITIAL_CURSORS });
    refreshRefs();
  }, [refreshRefs, targetKey]);
  const loadNext = useCallback(() => {
    if (!hasMore || nextCursor === null) return;
    setPagination((current) => {
      const currentCursors = current.targetKey === targetKey ? current.cursors : INITIAL_CURSORS;
      return currentCursors.includes(nextCursor)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, nextCursor] };
    });
  }, [hasMore, nextCursor, targetKey]);
  const retryFailedPage = useCallback(() => {
    const failedIndex = results.findIndex((result) => result._tag === "Failure");
    const failedPageAtom = failedIndex === -1 ? undefined : pageAtoms[failedIndex];
    if (failedPageAtom) appAtomRegistry.refresh(failedPageAtom);
  }, [pageAtoms, results]);

  return (
    <section
      ref={panelRef}
      className="@container/history-list flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Git history"
    >
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2"
        inert={mobilePane !== null ? true : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge
            variant="outline"
            className="min-w-0 max-w-64"
            title={selectedRevision?.label ?? "All refs"}
          >
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedRevision?.label ?? "All refs"}</span>
          </Badge>
          {history.length > 0 ? (
            <span className="hidden text-[0.6875rem] tabular-nums text-muted-foreground min-[440px]:inline">
              {history.length} commits
            </span>
          ) : null}
        </div>
        {!isWideLayout ? (
          <>
            <Button
              ref={branchesButtonRef}
              variant="ghost"
              size="xs"
              onClick={() => setMobilePane((pane) => (pane === "refs" ? null : "refs"))}
              aria-controls="git-history-refs-panel"
              aria-expanded={mobilePane === "refs"}
            >
              <GitBranchIcon className="size-3.5" /> Branches
            </Button>
            <Button
              ref={detailsButtonRef}
              variant="ghost"
              size="xs"
              onClick={() => setMobilePane((pane) => (pane === "details" ? null : "details"))}
              disabled={selectedHash === null}
              aria-controls="git-history-details-panel"
              aria-expanded={mobilePane === "details"}
            >
              <FileIcon className="size-3.5" /> Details
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
          disabled={isPending}
          aria-label="Refresh Git history"
        >
          <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
        </Button>
      </header>
      {commitDiffRequest ? (
        <CommitDiffView
          hash={commitDiffRequest.hash}
          {...(commitDiffRequest.filePath ? { filePath: commitDiffRequest.filePath } : {})}
          files={selectedCommitFiles}
          filesError={commitFilesQuery.error !== null}
          filesHasMore={commitFilesHasMore}
          filesLoading={commitFilesQuery.isPending}
          diff={commitDiffQuery.data?.diff ?? null}
          truncated={commitDiffQuery.data?.truncated ?? false}
          isPending={commitDiffQuery.isPending}
          error={commitDiffQuery.error}
          onBack={() => setCommitDiffRequest(null)}
          onSelectFile={(filePath) =>
            setCommitDiffRequest(
              filePath
                ? { hash: commitDiffRequest.hash, filePath }
                : { hash: commitDiffRequest.hash },
            )
          }
          onRetry={commitDiffQuery.refresh}
          onLoadMoreFiles={loadMoreCommitFiles}
          onRetryFiles={() => void commitFilesQuery.refresh()}
        />
      ) : isInitialLoad ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          <RefreshCwIcon className="mr-2 size-3.5 animate-spin" /> Loading history…
        </div>
      ) : error && history.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : !isRepo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This folder is not a Git repository.
        </div>
      ) : history.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This repository has no commits yet.
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {isWideLayout ? (
            <GitRefsPane
              className="!border-r-0"
              style={{
                width: refsPaneWidth,
                minWidth: refsPaneWidth,
                maxWidth: refsPaneWidth,
                flexBasis: refsPaneWidth,
              }}
              {...refPaneProps}
            />
          ) : null}
          {isWideLayout ? (
            <PaneResizeHandle
              label="Resize branches pane"
              value={refsPaneWidth}
              min={REFS_PANE_MIN_WIDTH}
              max={REFS_PANE_MAX_WIDTH}
              onMove={(delta) =>
                applyPaneWidths(
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: refsPaneWidthRef.current + delta,
                    detailsPaneWidth: detailsPaneWidthRef.current,
                  }),
                )
              }
              onReset={() =>
                applyPaneWidths(
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: 256,
                    detailsPaneWidth: detailsPaneWidthRef.current,
                  }),
                )
              }
            />
          ) : null}
          <div
            className="@container min-h-0 min-w-0 flex-1 overflow-hidden"
            inert={mobilePane !== null ? true : undefined}
          >
            <div className="flex h-full min-w-0 flex-col">
              <div className="relative shrink-0 border-b border-border/60 p-2">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  className="h-7 w-full rounded border border-input bg-background/30 pr-7 pl-7 text-[0.6875rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || filter.length === 0) return;
                    event.preventDefault();
                    setFilter("");
                  }}
                  placeholder="Text or hash"
                  aria-label="Filter Git history"
                />
                {filter.length > 0 ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="absolute top-1/2 right-3 size-5 -translate-y-1/2 rounded-sm text-muted-foreground"
                    aria-label="Clear Git history search"
                    onClick={() => {
                      setFilter("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              {error ? (
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[0.6875rem] text-destructive">
                  <span className="truncate">{error}</span>
                  <Button size="xs" variant="ghost" className="shrink-0" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              <div className="flex h-7 shrink-0 items-center border-b border-border/70 bg-muted/20 text-[0.625rem] font-medium text-muted-foreground">
                <div className="shrink-0" style={{ width: graphColumnWidth(laneCount) }} />
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)_minmax(5rem,7rem)_8.5rem_5rem] gap-x-3 pr-3 @max-[720px]:grid-cols-[minmax(10rem,1fr)_5rem]">
                  <span>Subject</span>
                  <span className="@max-[720px]:hidden" />
                  <span className="@max-[720px]:hidden">Author</span>
                  <span className="@max-[720px]:hidden">Date</span>
                  <span>Hash</span>
                </div>
              </div>
              {filteredRows.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
                  <span className={error ? "text-destructive" : undefined}>
                    {error ?? "No loaded commits match this filter."}
                  </span>
                  {error || hasMore ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={error ? retryFailedPage : loadNext}
                      disabled={isFetchingNextPage}
                    >
                      {isFetchingNextPage
                        ? "Searching older commits…"
                        : error
                          ? "Retry older commits"
                          : "Search older commits"}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <LegendList<GitHistoryRow>
                  data={filteredRows}
                  keyExtractor={(row) => row.commit.hash}
                  renderItem={({ item }) => (
                    <CommitRow
                      row={item}
                      laneCount={laneCount}
                      rowHeight={rowHeight}
                      refKinds={commitRefKinds}
                      {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
                      selected={item.commit.hash === selectedHash}
                      onSelect={setSelectedHash}
                    />
                  )}
                  estimatedItemSize={rowHeight}
                  drawDistance={rowHeight * 8}
                  recycleItems={false}
                  className="min-h-0 flex-1 overscroll-y-contain"
                />
              )}
              {filteredRows.length > 0 && (hasMore || isFetchingNextPage) ? (
                <div className="flex shrink-0 justify-center border-t border-border/50 p-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={loadNext}
                    disabled={isFetchingNextPage}
                  >
                    {isFetchingNextPage ? "Loading more…" : "Load more"}
                  </Button>
                </div>
              ) : null}
              {filteredRows.length > 0 && historyLimitReached && hasMoreFromServer ? (
                <div className="shrink-0 border-t border-border/50 px-3 py-2 text-center text-[0.6875rem] text-muted-foreground">
                  Showing the first {HISTORY_PAGE_SIZE * MAX_HISTORY_PAGES} commits. Choose a branch
                  or refine the search to keep history responsive.
                </div>
              ) : null}
            </div>
          </div>
          {isWideLayout ? (
            <PaneResizeHandle
              label="Resize commit details pane"
              value={detailsPaneWidth}
              min={DETAILS_PANE_MIN_WIDTH}
              max={DETAILS_PANE_MAX_WIDTH}
              onMove={(delta) =>
                applyPaneWidths(
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: refsPaneWidthRef.current,
                    detailsPaneWidth: detailsPaneWidthRef.current - delta,
                  }),
                )
              }
              onReset={() =>
                applyPaneWidths(
                  clampHistoryPaneWidths({
                    panelWidth: panelWidthRef.current,
                    refsPaneWidth: refsPaneWidthRef.current,
                    detailsPaneWidth: 384,
                  }),
                )
              }
            />
          ) : null}
          {isWideLayout ? (
            <CommitDetailsPane
              className="!border-l-0"
              style={{
                width: detailsPaneWidth,
                minWidth: detailsPaneWidth,
                maxWidth: detailsPaneWidth,
                flexBasis: detailsPaneWidth,
              }}
              details={selectedCommitDetails}
              files={selectedCommitFiles}
              filesCapped={commitFilesCapped}
              filesHasMore={commitFilesHasMore}
              filesError={commitFilesQuery.error !== null}
              filesLoading={commitFilesQuery.isPending}
              onLoadMoreFiles={loadMoreCommitFiles}
              onRetryFiles={() => void commitFilesQuery.refresh()}
              isPending={commitDetailsQuery.isPending}
              hasError={commitDetailsQuery.error !== null}
              hasSelection={selectedHash !== null}
              onRetry={commitDetailsQuery.refresh}
              onShowDiff={(hash, filePath) =>
                setCommitDiffRequest(filePath ? { hash, filePath } : { hash })
              }
            />
          ) : null}
          {!isWideLayout && mobilePane === "refs" ? (
            <Sheet
              open={mobilePane === "refs"}
              onOpenChange={(open) => !open && setMobilePane(null)}
            >
              <SheetPopup side="left" showCloseButton={false} className="w-full max-w-none p-0">
                <SheetTitle className="sr-only">Branches and tags</SheetTitle>
                <GitRefsPane
                  id="git-history-refs-panel"
                  className="!w-full !min-w-0 !max-w-none !flex-1 !border-r-0 !bg-background"
                  {...refPaneProps}
                  onClose={() => setMobilePane(null)}
                />
              </SheetPopup>
            </Sheet>
          ) : null}
          {!isWideLayout && mobilePane === "details" ? (
            <Sheet
              open={mobilePane === "details"}
              onOpenChange={(open) => !open && setMobilePane(null)}
            >
              <SheetPopup side="right" showCloseButton className="w-full max-w-none p-0">
                <SheetTitle className="sr-only">Commit details</SheetTitle>
                <CommitDetailsPane
                  id="git-history-details-panel"
                  className="!w-full !min-w-0 !max-w-none !flex-1 !border-l-0"
                  details={selectedCommitDetails}
                  files={selectedCommitFiles}
                  filesCapped={commitFilesCapped}
                  filesHasMore={commitFilesHasMore}
                  filesError={commitFilesQuery.error !== null}
                  filesLoading={commitFilesQuery.isPending}
                  onLoadMoreFiles={loadMoreCommitFiles}
                  onRetryFiles={() => void commitFilesQuery.refresh()}
                  isPending={commitDetailsQuery.isPending}
                  hasError={commitDetailsQuery.error !== null}
                  hasSelection={selectedHash !== null}
                  onRetry={commitDetailsQuery.refresh}
                  onShowDiff={(hash, filePath) =>
                    setCommitDiffRequest(filePath ? { hash, filePath } : { hash })
                  }
                />
              </SheetPopup>
            </Sheet>
          ) : null}
        </div>
      )}
    </section>
  );
}
