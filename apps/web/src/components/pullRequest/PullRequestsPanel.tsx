import type {
  EnvironmentId,
  IssueLink,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListEntry,
  PullRequestListFilters,
  PullRequestListStatsResult,
  PullRequestListState,
  PullRequestState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowLeftIcon,
  EyeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  LayersIcon,
  LoaderIcon,
  PenLineIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { DraftId } from "~/composerDraftStore";

import { ListGhost } from "../sourceControl/ListGhosts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import {
  filterPullRequestsByInvolvement,
  decoratePullRequestEntries,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  mergePullRequestDiffStats,
  parsePullRequestQuery,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  pullRequestStatsTargets,
  prunePullRequestDiffStats,
  rankPullRequestMatches,
  type EnvironmentPullRequestEntry,
  type EnvironmentPullRequestStat,
  type PullRequestDiffStats,
} from "./pullRequestList.logic";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { PullRequestFiltersMenu, type PullRequestFilterOption } from "./PullRequestListFilters";
import { PullRequestRow } from "./PullRequestRow";

const STATE_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: GitPullRequestIcon },
  { value: "closed", label: "Closed", Icon: GitPullRequestClosedIcon },
  { value: "merged", label: "Merged", Icon: GitMergeIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

const INVOLVEMENT_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "reviewing", label: "Reviewing", Icon: EyeIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 30;
const MAX_LIMIT = 500;

export interface PullRequestPanelSelection {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}

interface PullRequestsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly selected: PullRequestPanelSelection | null;
  readonly onSelect: (selection: PullRequestPanelSelection | null) => void;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId;
  readonly onOpenLinkedIssue?: (link: IssueLink) => void;
  readonly onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: PullRequestState;
    isDraft: boolean;
  }) => void;
}

interface PanelPage {
  readonly key: string;
  readonly size: number;
  readonly cursors: PullRequestListCursors | null;
}

function usePanelPullRequestListStats(
  targets: ReadonlyArray<Parameters<typeof pullRequestEnvironment.listStats>[0]>,
) {
  const [results, setResults] = useState<
    ReadonlyMap<number, readonly [EnvironmentId, PullRequestListStatsResult]>
  >(() => new Map());
  useEffect(() => {
    setResults(new Map());
    const subscriptions = targets.map((target, index) => {
      const atom = pullRequestEnvironment.listStats(target);
      const update = (result: AsyncResult.AsyncResult<PullRequestListStatsResult, unknown>) => {
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null) return;
        setResults((previous) => {
          const next = new Map(previous);
          next.set(index, [target.environmentId, value]);
          return next;
        });
      };
      const unsubscribe = appAtomRegistry.subscribe(atom, update);
      update(appAtomRegistry.get(atom));
      return unsubscribe;
    });
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [targets]);
  const stats = useMemo<ReadonlyArray<EnvironmentPullRequestStat> | null>(
    () =>
      results.size === 0
        ? null
        : [...results.values()].flatMap(([environmentId, result]) =>
            result.stats.map((stat) => ({ ...stat, environmentId })),
          ),
    [results],
  );
  const refresh = useCallback(() => {
    for (const target of targets) {
      appAtomRegistry.refresh(pullRequestEnvironment.listStats(target));
    }
  }, [targets]);
  return { stats, refresh };
}

export function PullRequestsPanel(props: PullRequestsPanelProps) {
  return <ProjectPullRequests key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function ProjectPullRequests(props: PullRequestsPanelProps) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  }>({ state: "open", involvement: "all", extra: {} });
  const [page, setPage] = useState<PanelPage>({ key: "", size: PAGE_SIZE, cursors: null });
  const [refreshPending, setRefreshPending] = useState(false);
  const [ordered, setOrdered] = useState<{
    readonly key: string;
    readonly entries: ReadonlyArray<PullRequestListEntry>;
    readonly truncated: boolean;
  } | null>(null);
  const [statsByRow, setStatsByRow] = useState<PullRequestDiffStats>(() => new Map());

  return (
    <div className="relative h-full min-h-0">
      {props.selected ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center border-b border-border/50 px-1.5 py-1">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 text-muted-foreground"
              onClick={() => props.onSelect(null)}
            >
              <ArrowLeftIcon className="size-3.5" />
              All pull requests
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <PullRequestDetailPanel
              key={`${props.selected.repository}#${props.selected.number}`}
              environmentId={props.environmentId}
              reference={props.selected}
              context="page"
              onActed={() => setRefreshPending(true)}
              {...(props.onStateChange ? { onStateChange: props.onStateChange } : {})}
              {...(props.onOpenLinkedIssue ? { onOpenLinkedIssue: props.onOpenLinkedIssue } : {})}
              {...(props.composerDraftTarget
                ? { composerDraftTarget: props.composerDraftTarget }
                : {})}
            />
          </div>
        </div>
      ) : null}
      {props.selected === null ? (
        <div className="h-full min-h-0">
          <PullRequestBrowserList
            environmentId={props.environmentId}
            projectId={props.projectId}
            onSelect={props.onSelect}
            query={query}
            onQuery={setQuery}
            filters={filters}
            onFilters={setFilters}
            page={page}
            onPage={setPage}
            ordered={ordered}
            onOrdered={setOrdered}
            statsByRow={statsByRow}
            onStatsByRow={setStatsByRow}
            refreshPending={refreshPending}
            onRefreshConsumed={() => setRefreshPending(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

function PullRequestBrowserList({
  environmentId,
  projectId,
  onSelect,
  query,
  onQuery,
  filters,
  onFilters,
  page,
  onPage,
  ordered,
  onOrdered,
  statsByRow,
  onStatsByRow,
  refreshPending,
  onRefreshConsumed,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onSelect: (selection: PullRequestPanelSelection) => void;
  query: string;
  onQuery: (query: string) => void;
  filters: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  };
  onFilters: (filters: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly extra: PullRequestListFilters;
  }) => void;
  page: PanelPage;
  onPage: (page: PanelPage) => void;
  ordered: {
    readonly key: string;
    readonly entries: ReadonlyArray<PullRequestListEntry>;
    readonly truncated: boolean;
  } | null;
  onOrdered: Dispatch<
    SetStateAction<{
      readonly key: string;
      readonly entries: ReadonlyArray<PullRequestListEntry>;
      readonly truncated: boolean;
    } | null>
  >;
  statsByRow: PullRequestDiffStats;
  onStatsByRow: Dispatch<SetStateAction<PullRequestDiffStats>>;
  refreshPending: boolean;
  onRefreshConsumed: () => void;
}) {
  const typed = query.trim().slice(0, 200);
  const sent = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);
  const typedParsed = useMemo(() => parsePullRequestQuery(typed), [typed]);
  const sentParsed = useMemo(() => parsePullRequestQuery(sent), [sent]);
  const requestFilters = useMemo(
    () => ({ ...filters.extra, ...sentParsed.filters }),
    [filters.extra, sentParsed.filters],
  );
  const localFilters = useMemo(
    () => ({ ...filters.extra, ...typedParsed.filters }),
    [filters.extra, typedParsed.filters],
  );
  const filterKey = `${filters.state}:${filters.involvement}:${JSON.stringify(requestFilters)}:${sentParsed.text}`;
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;

  useEffect(() => {
    onPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
  }, [filterKey, onPage]);

  const listQuery = useEnvironmentQuery(
    pullRequestEnvironment.list({
      environmentId,
      input: {
        state: filters.state,
        involvement: filters.involvement,
        projectId,
        limit: pageSize,
        ...(Object.keys(requestFilters).length > 0 ? { filters: requestFilters } : {}),
        ...(sentParsed.text ? { query: sentParsed.text } : {}),
        ...(sentCursors === null ? {} : { cursors: sentCursors }),
      },
    }),
  );
  const answered = listQuery.data;
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [invalidating, setInvalidating] = useState(false);
  useEffect(() => {
    if (answered === null) return;
    onOrdered((previous) => {
      if (previous === null || previous.key !== filterKey || sentCursors === null) {
        return {
          key: filterKey,
          entries: rankPullRequestMatches(answered.entries, sentParsed.text),
          truncated: answered.truncated,
        };
      }
      const held = new Set(previous.entries.map(pullRequestEntryKey));
      return {
        key: filterKey,
        entries: [
          ...previous.entries,
          ...answered.entries.filter((entry) => !held.has(pullRequestEntryKey(entry))),
        ],
        truncated: answered.truncated,
      };
    });
  }, [answered, filterKey, sentCursors, sentParsed.text]);

  const entries = useMemo(() => {
    const held = ordered?.key === filterKey ? ordered.entries : (answered?.entries ?? []);
    const searchingHosts = new Set(
      (answered?.providers ?? [])
        .filter((provider) => provider.searchesOnHost)
        .map((provider) => provider.host),
    );
    const narrowed = filterPullRequestsByInvolvement(
      held,
      answered?.viewers ?? {},
      filters.involvement,
    ).filter(
      (entry) =>
        (typedParsed.text.length === 0 ||
          searchingHosts.has(entry.host) ||
          matchesPullRequestQuery(entry, typedParsed.text)) &&
        matchesPullRequestFilters(
          entry,
          localFilters,
          pullRequestEntryViewer(entry, answered?.viewers ?? {}),
        ),
    );
    return narrowed.map((entry): EnvironmentPullRequestEntry => ({ ...entry, environmentId }));
  }, [
    answered,
    environmentId,
    filterKey,
    filters.involvement,
    localFilters,
    ordered,
    typedParsed.text,
  ]);

  const statsTargets = useMemo(() => pullRequestStatsTargets(entries), [entries]);
  useEffect(() => {
    onStatsByRow((previous) => prunePullRequestDiffStats(previous, entries));
  }, [entries, onStatsByRow]);
  const statsQuery = usePanelPullRequestListStats(statsTargets);
  useEffect(() => {
    if (statsQuery.stats === null) return;
    onStatsByRow((previous) => mergePullRequestDiffStats(previous, statsQuery.stats ?? []));
  }, [onStatsByRow, statsQuery.stats]);
  const decorationCache = useRef<
    ReadonlyMap<EnvironmentPullRequestEntry, EnvironmentPullRequestEntry>
  >(new Map());
  const decoration = useMemo(
    () => decoratePullRequestEntries(entries, statsByRow, decorationCache.current),
    [entries, statsByRow],
  );
  useEffect(() => {
    decorationCache.current = decoration.bySource;
  }, [decoration]);
  const decoratedEntries = decoration.entries;
  const groups = useMemo(
    () =>
      filters.involvement === "all"
        ? groupPullRequestsByInvolvement(decoratedEntries, answered?.viewers ?? {})
        : [{ key: "others" as const, label: "", entries: decoratedEntries }],
    [answered?.viewers, decoratedEntries, filters.involvement],
  );

  const truncated = ordered?.key === filterKey ? ordered.truncated : (answered?.truncated ?? false);
  const nextCursors = answered?.nextCursors ?? {};
  const canContinue = Object.keys(nextCursors).length > 0;
  const loadingMore = listQuery.isPending && entries.length > 0;
  const loadMore = useCallback(() => {
    onPage(
      canContinue
        ? { key: filterKey, size: pageSize, cursors: nextCursors }
        : { key: filterKey, size: Math.min(pageSize + PAGE_SIZE, MAX_LIMIT), cursors: null },
    );
  }, [canContinue, filterKey, nextCursors, onPage, pageSize]);

  const refreshList = useCallback(() => {
    if (sentCursors === null) {
      listQuery.refresh();
      return;
    }
    const loadedCount = ordered?.key === filterKey ? ordered.entries.length : pageSize;
    onPage({
      key: filterKey,
      size: Math.min(Math.max(pageSize, Math.ceil(loadedCount / PAGE_SIZE) * PAGE_SIZE), MAX_LIMIT),
      cursors: null,
    });
  }, [filterKey, listQuery.refresh, onPage, ordered, pageSize, sentCursors]);

  const consumedRefresh = useRef(false);
  useEffect(() => {
    if (!refreshPending) {
      consumedRefresh.current = false;
      return;
    }
    if (consumedRefresh.current) return;
    consumedRefresh.current = true;
    refreshList();
    statsQuery.refresh();
    onRefreshConsumed();
  }, [onRefreshConsumed, refreshList, refreshPending, statsQuery.refresh]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      entries.length === 0 ||
      !truncated ||
      listQuery.isPending ||
      listQuery.error !== null ||
      (!canContinue && pageSize >= MAX_LIMIT)
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    canContinue,
    entries.length,
    listQuery.error,
    listQuery.isPending,
    loadMore,
    pageSize,
    truncated,
  ]);

  const select = useCallback(
    (entry: EnvironmentPullRequestEntry) =>
      onSelect({ projectId, repository: entry.repository, number: entry.number }),
    [onSelect, projectId],
  );
  const narrowed =
    filters.state !== "open" ||
    filters.involvement !== "all" ||
    Object.keys(localFilters).length > 0;
  const refreshFromHost = useCallback(async () => {
    setInvalidating(true);
    try {
      await invalidate({ environmentId, input: {} });
    } finally {
      setInvalidating(false);
    }
    refreshList();
    statsQuery.refresh();
  }, [environmentId, invalidate, refreshList, statsQuery.refresh]);
  const refreshing = invalidating || listQuery.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Input
          value={query}
          aria-label="Search pull requests"
          placeholder="Search pull requests, or label:bug"
          onChange={(event) => onQuery(event.target.value)}
        />
        <PullRequestFiltersMenu
          state={filters.state}
          stateOptions={STATE_OPTIONS}
          onState={(state) => onFilters({ ...filters, state })}
          involvement={filters.involvement}
          involvementOptions={INVOLVEMENT_OPTIONS}
          onInvolvement={(involvement) => onFilters({ ...filters, involvement })}
          filters={filters.extra}
          onFilters={(extra) => onFilters({ ...filters, extra })}
          host={undefined}
          hostOptions={[]}
          onHost={() => undefined}
          server={undefined}
          serverOptions={[]}
          onServer={() => undefined}
          projects={[]}
          projectId={undefined}
          projectEnvironmentId={undefined}
          unavailable={new Map()}
          onProject={() => undefined}
          showProjectScope={false}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh pull requests"
          disabled={refreshing}
          onClick={() => void refreshFromHost()}
        >
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-1 pb-2">
          {entries.length === 0 && listQuery.isPending ? (
            <ListGhost rows={7} label="Loading pull requests" />
          ) : listQuery.error !== null && listQuery.data === null ? (
            <div className="space-y-2 px-2 text-sm text-muted-foreground">
              <p>{listQuery.error}</p>
              <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                Retry
              </Button>
            </div>
          ) : entries.length === 0 &&
            (listQuery.error !== null || (answered?.errors.length ?? 0) > 0) ? (
            <div className="space-y-2 px-2 text-sm text-muted-foreground">
              <p>Some pull requests could not be loaded.</p>
              <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="space-y-2 px-2">
              <p className="text-sm text-muted-foreground">
                {typed.length > 0
                  ? "No pull request here matches that."
                  : narrowed
                    ? "No pull request here matches these filters."
                    : "This repository has no pull requests to open."}
              </p>
              {truncated && (canContinue || pageSize < MAX_LIMIT) ? (
                <Button variant="outline" size="xs" onClick={loadMore}>
                  Load more
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.key} className="space-y-0.5">
                  {group.label ? (
                    <h2 className="px-2 pb-0.5 text-xs font-medium text-muted-foreground/70">
                      {group.label}
                    </h2>
                  ) : null}
                  {group.entries.map((entry) => (
                    <PullRequestRow
                      key={pullRequestEntryKey(entry)}
                      entry={entry}
                      selected={false}
                      showProjectTitle={false}
                      showProvider={false}
                      onSelect={select}
                    />
                  ))}
                </div>
              ))}
              {answered?.errors.length ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                  <span>Some pull requests could not be loaded.</span>
                  <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {listQuery.error !== null ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                  <span>The latest request failed. Showing the last pull requests loaded.</span>
                  <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {truncated ? (
                <div
                  ref={sentinelRef}
                  className="flex justify-center py-2 text-xs text-muted-foreground"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-2">
                      <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
                      Loading more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
