import { pullRequestHostOf } from "@t3tools/contracts";
import type {
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestListState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  EyeIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LayersIcon,
  PenLineIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
  pullRequestEntryKey,
  resolveProjectScope,
} from "../components/pullRequest/pullRequestList.logic";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import {
  PullRequestFilterPills,
  PullRequestProjectFilter,
  PullRequestProviderFilter,
  PullRequestSearchInput,
  type PullRequestExpectedHost,
  type PullRequestFilterOption,
} from "../components/pullRequest/PullRequestListFilters";
import { PullRequestListEmptyState } from "../components/pullRequest/PullRequestListEmptyState";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { RightPanelResizeHandle } from "../components/preview/RightPanelResizeHandle";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useDebouncedValue } from "../state/queries";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

export interface PullRequestsSearch {
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  /** Scopes the list. Separate from the selection so one cannot silently change the other. */
  readonly projectId?: ProjectId;
  /**
   * Narrows the list to one host, named as the host itself: two GitHub installs are two
   * accounts, and their shared provider kind cannot tell them apart. Absent means every host.
   */
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly q?: string;
}

// The state filters wear the same glyphs the rows do, so the two read as one vocabulary.
const INVOLVEMENT_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "reviewing", label: "Reviewing", Icon: EyeIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

const STATE_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: GitPullRequestIcon },
  { value: "closed", label: "Closed", Icon: GitPullRequestClosedIcon },
  { value: "merged", label: "Merged", Icon: GitMergeIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

/** Long enough that a keystroke does not become a request, short enough to feel answered. */
const SEARCH_DEBOUNCE_MS = 250;
/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const PAGE_SIZE = 99;
/** The largest page the listing accepts; past it the request is refused outright. */
const MAX_PAGE_SIZE = 500;
/** Stable empty map so the memos below do not see a new object on every render. */
const EMPTY_VIEWERS: PullRequestListResult["viewers"] = {};
/** Matches the panel's transition so it can animate out before it leaves the tree. */
const DETAIL_CLOSE_ANIMATION_MS = 200;
const DETAIL_WIDTH_STORAGE_KEY = "t3code:pull-requests-detail-width";
const DETAIL_MIN_WIDTH = 420;
const DETAIL_DEFAULT_WIDTH = 640;
const DETAIL_MAX_WIDTH = 1100;

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch => ({
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  }),
  component: PullRequestsRouteView,
});

function PullRequestsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const environmentId = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  // The page reads one environment, so a project from another one could neither be listed
  // nor acted on: scoping here keeps the filter and the selection honest.
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const scopedProjects = useMemo(
    () =>
      projects
        .map((project) => ({ id: project.id, title: project.title }))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
  // The scope the URL asks for, once the environment has had its say about whether it exists.
  const scopedProjectId = useMemo(
    () => resolveProjectScope(search.projectId, projects),
    [projects, search.projectId],
  );
  const detailPanel = useResizableWidth({
    storageKey: DETAIL_WIDTH_STORAGE_KEY,
    defaultWidth: DETAIL_DEFAULT_WIDTH,
    minWidth: DETAIL_MIN_WIDTH,
    maxWidth: DETAIL_MAX_WIDTH,
    edge: "left",
  });

  const updateSearch = (patch: {
    [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
  }) =>
    void navigate({
      // Rebuilt rather than spread so a cleared field leaves the URL instead of
      // lingering as an explicit `undefined`.
      search: (previous: PullRequestsSearch): PullRequestsSearch => {
        const next = { ...previous, ...patch };
        return {
          involvement: next.involvement ?? previous.involvement,
          state: next.state ?? previous.state,
          ...(next.repository ? { repository: next.repository } : {}),
          ...(next.number ? { number: next.number } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.host ? { host: next.host } : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.q ? { q: next.q } : {}),
        };
      },
      replace: true,
    });

  // Changing what the list contains must not leave a selection from the previous view open.
  // The project filter is untouched: it is the user's scope, not part of the selection.
  const clearedSelection = {
    repository: undefined,
    number: undefined,
    selectedProjectId: undefined,
  };

  // Searching asks the hosts, which takes a round trip, so the text is held for a moment before
  // it is sent. Until it lands, the rows already on screen are narrowed locally: the answer is
  // late but the page is not.
  const typedQuery = (search.q ?? "").trim();
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
  const querySettled = typedQuery === sentQuery;

  // Page size is view state, not a URL concern: a shared link should open the first page.
  const scopeKey = `${environmentId ?? ""}:${search.state}:${search.involvement}:${scopedProjectId ?? ""}:${search.host ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;
  const [page, setPage] = useState({ key: filterKey, size: PAGE_SIZE });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const loadMore = () =>
    setPage({ key: filterKey, size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE) });

  const listQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId,
          input: {
            state: search.state,
            limit: pageSize,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
          },
        }),
  );

  // Every page size and every search is its own query, and a new one starts empty. The last
  // answer for these filters is held so the page grows and narrows in place rather than blanking
  // out: a longer page reads as growth, and a search shows the rows it already has, narrowed
  // here, until the hosts answer for themselves.
  const [loaded, setLoaded] = useState<{
    scope: string;
    query: string;
    data: PullRequestListResult;
  } | null>(null);
  useEffect(() => {
    if (listQuery.data) setLoaded({ scope: scopeKey, query: sentQuery, data: listQuery.data });
  }, [scopeKey, sentQuery, listQuery.data]);
  const answered =
    listQuery.data ??
    (loaded?.scope === scopeKey && loaded.query === sentQuery ? loaded.data : null);
  const carried = loaded?.scope === scopeKey ? loaded.data : null;
  const listData = answered ?? carried;
  /** The rows on screen are the previous search's, held while this one is on its way. */
  const showingCarried = answered === null && carried !== null;
  const loadingMore = listQuery.isPending && listData !== null;
  const firstLoad = listQuery.isPending && listData === null;

  // A longer page is the same list with more on the end, so the rows already read stay where
  // they were read: each answer is merged onto the last rather than replacing it, and anything
  // new lands at the bottom. Only a different question — other filters, another search — starts
  // the order again.
  const [ordered, setOrdered] = useState<{
    key: string;
    entries: ReadonlyArray<PullRequestListEntry>;
  } | null>(null);
  useEffect(() => {
    if (!answered) return;
    setOrdered((previous) => {
      if (previous === null || previous.key !== filterKey) {
        return { key: filterKey, entries: answered.entries };
      }
      const arriving = new Map(
        answered.entries.map((entry) => [pullRequestEntryKey(entry), entry] as const),
      );
      const kept = previous.entries.flatMap((entry) => {
        const key = pullRequestEntryKey(entry);
        const fresh = arriving.get(key);
        if (fresh === undefined) return [];
        arriving.delete(key);
        // The row's own contents are the newest ones; only its place is inherited.
        return [fresh];
      });
      return { key: filterKey, entries: [...kept, ...arriving.values()] };
    });
  }, [answered, filterKey]);

  /** The hosts that narrowed the listing themselves, so their answer is not narrowed again. */
  const searchingHosts = useMemo(
    () =>
      new Set(
        (listData?.providers ?? []).flatMap((provider) =>
          provider.searchesOnHost ? [provider.host] : [],
        ),
      ),
    [listData?.providers],
  );

  const entries = useMemo(() => {
    const known = ordered?.key === filterKey ? ordered.entries : (listData?.entries ?? []);
    const involvementEntries = filterPullRequestsByInvolvement(
      known,
      listData?.viewers ?? EMPTY_VIEWERS,
      search.involvement,
    );
    // The hosts search more than the row shows — a body, a review, a commit message — so once
    // their answer is in, narrowing it again here would throw away matches the reader asked for.
    // The local pass stands in for the answer that has not arrived yet, and for the hosts that
    // answered without searching at all: Azure DevOps has no text filter, so its rows arrive
    // whole and would otherwise sit under a search that never touched them.
    if (typedQuery.length === 0) return involvementEntries;
    const answeredLocally = querySettled && !showingCarried;
    return involvementEntries.filter(
      (entry) =>
        (answeredLocally && searchingHosts.has(entry.host)) ||
        matchesPullRequestQuery(entry, typedQuery),
    );
  }, [
    filterKey,
    listData,
    ordered,
    querySettled,
    search.involvement,
    searchingHosts,
    showingCarried,
    typedQuery,
  ]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // A failed page must stop the observer. Retained rows keep the sentinel on screen, so
    // re-arming it after a failure would ask for the next page again, forever.
    //
    // Rows on screen are also what makes reaching the sentinel mean anything: with none, it
    // sits directly below the empty state and is always in view, so a search that matches
    // nothing would page through the whole host on its own — one listing of every repository
    // per step — while the reader looks at an empty page. With nothing to scroll past, the
    // next page is asked for rather than assumed.
    if (
      !sentinel ||
      entries.length === 0 ||
      listData?.truncated !== true ||
      listQuery.isPending ||
      listQuery.error !== null ||
      // Asking past the cap is refused, which would strand the list on an error the retry
      // could never clear, so growth stops here and the rest stays on the host.
      pageSize >= MAX_PAGE_SIZE
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      // Start the next page slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `loadMore` closes over the page state it advances, which the rest of the list already
    // depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entries.length,
    filterKey,
    listData?.truncated,
    listQuery.error,
    listQuery.isPending,
    pageSize,
  ]);

  const groups = useMemo(
    () =>
      search.involvement === "all"
        ? groupPullRequestsByInvolvement(entries, listData?.viewers ?? EMPTY_VIEWERS)
        : [{ key: "others" as const, label: "", entries }],
    [entries, listData?.viewers, search.involvement],
  );

  // A link from a thread or the sidebar only knows the repository, so the owning project is
  // resolved here; an explicit `projectId` in the URL still wins.
  const projectIdForRepository = useMemo(() => {
    const repository = search.repository?.toLowerCase();
    if (repository === undefined) return undefined;
    const identity = projects.find(
      (project) =>
        project.repositoryIdentity?.owner &&
        project.repositoryIdentity.name &&
        `${project.repositoryIdentity.owner}/${project.repositoryIdentity.name}`.toLowerCase() ===
          repository &&
        // The same `owner/name` can exist on two hosts. Without this the first match wins, and
        // a link that named its host opens the pull request from the other one.
        (search.host === undefined ||
          pullRequestHostOf(
            project.repositoryIdentity,
            project.repositoryIdentity.provider as SourceControlProviderKind,
          ) === search.host.toLowerCase()),
    );
    return identity?.id;
  }, [projects, search.host, search.repository]);

  // The selection is resolved the same way the scope is: an id from another environment can
  // never be read here, and one that arrived before the projects did is not yet wrong.
  const linkedProjectId = useMemo(
    () => resolveProjectScope(search.selectedProjectId, projects),
    [projects, search.selectedProjectId],
  );
  const selectedProjectId = linkedProjectId ?? projectIdForRepository;
  const selected =
    search.repository && search.number && selectedProjectId
      ? { repository: search.repository, number: search.number, projectId: selectedProjectId }
      : null;

  const [renderedSelection, setRenderedSelection] = useState(selected);
  useEffect(() => {
    if (selected !== null) {
      setRenderedSelection(selected);
      return;
    }
    const timeout = window.setTimeout(() => setRenderedSelection(null), DETAIL_CLOSE_ANIMATION_MS);
    return () => window.clearTimeout(timeout);
    // Depend on the identity fields: `selected` is a fresh object on every render.
  }, [selected?.projectId, selected?.repository, selected?.number]);

  // The provider list is the workspace's hosts, not the filtered ones, so switching to a host
  // cannot make the switcher that got you there disappear.
  const [hosts, setHosts] = useState<PullRequestListResult["providers"]>([]);
  useEffect(() => {
    if (listData === null) return;
    // An unfiltered response is the full set of hosts. A filtered one only seeds the switcher
    // when there is nothing to seed it with, which is a link that arrived already scoped.
    setHosts((previous) =>
      search.host === undefined || previous.length === 0 ? listData.providers : previous,
    );
  }, [listData, search.host]);
  const showProvider = hosts.length > 1;
  // The workspace's own projects already name their hosts, so the row's shape is known before
  // the list is. Only its shape: which hosts can actually be read still comes from the server.
  const expectedHosts = useMemo(() => {
    const byHost = new Map<string, PullRequestExpectedHost>();
    for (const project of projects) {
      const kind = project.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      if (kind === undefined) continue;
      const host = pullRequestHostOf(project.repositoryIdentity, kind);
      if (!byHost.has(host)) byHost.set(host, { host, kind });
    }
    return [...byHost.values()];
  }, [projects]);

  /** Reported per project rather than as a count, so the reader can see which one it was. */
  const unavailableProjects = useMemo(
    () =>
      new Map((listData?.errors ?? []).map((error) => [error.projectId, error.message] as const)),
    [listData?.errors],
  );

  const selectEntry = (entry: PullRequestListEntry) =>
    updateSearch({
      repository: entry.repository,
      number: entry.number,
      selectedProjectId: entry.projectId,
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className={cn(
              "workspace-topbar gap-2 border-b border-border/60 px-3 sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <h1 className="truncate text-sm font-medium">Pull Requests</h1>
            <div className="min-w-0 flex-1" />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh pull requests"
              onClick={() => listQuery.refresh()}
            >
              <RefreshCwIcon className={cn("size-4", listQuery.isPending && "animate-spin")} />
            </Button>
          </header>

          <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 pb-12 pt-4">
              <div className="flex flex-col gap-3">
                {/* Each group is its own control, so they can share a row without the two
                    "All" options reading as one list. */}
                <div className="flex flex-wrap items-center gap-2">
                  <PullRequestFilterPills
                    label="Filter by involvement"
                    value={search.involvement}
                    options={INVOLVEMENT_TABS}
                    onChange={(involvement) => updateSearch({ involvement, ...clearedSelection })}
                  />
                  <PullRequestFilterPills
                    label="Filter by state"
                    value={search.state}
                    options={STATE_TABS}
                    onChange={(state) => updateSearch({ state, ...clearedSelection })}
                  />
                  <PullRequestProviderFilter
                    providers={hosts}
                    value={search.host}
                    expectedHosts={expectedHosts}
                    onChange={(host) => updateSearch({ host, ...clearedSelection })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <PullRequestSearchInput
                    value={search.q ?? ""}
                    busy={typedQuery.length > 0 && (!querySettled || showingCarried)}
                    onChange={(query) => updateSearch({ q: query || undefined })}
                  />
                  <PullRequestProjectFilter
                    projects={scopedProjects}
                    value={scopedProjectId}
                    unavailable={unavailableProjects}
                    onChange={(projectId) => updateSearch({ ...clearedSelection, projectId })}
                  />
                </div>
              </div>

              {firstLoad ? (
                <div className="space-y-1">
                  {Array.from({ length: 7 }, (_, index) => (
                    <Skeleton key={index} className="h-13 w-full rounded-lg" />
                  ))}
                </div>
              ) : listQuery.error && listData === null ? (
                <PullRequestsUnavailableState
                  error={listQuery.error}
                  onRetry={() => listQuery.refresh()}
                />
              ) : entries.length === 0 ? (
                <PullRequestListEmptyState
                  query={typedQuery}
                  filtered={
                    search.state !== "open" ||
                    search.involvement !== "all" ||
                    scopedProjectId !== undefined ||
                    search.host !== undefined
                  }
                  searching={typedQuery.length > 0 && (!querySettled || showingCarried)}
                  canLoadMore={listData?.truncated === true && pageSize < MAX_PAGE_SIZE}
                  loadingMore={loadingMore}
                  onClearQuery={() => updateSearch({ q: undefined })}
                  onLoadMore={loadMore}
                />
              ) : (
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div key={group.key} className="space-y-0.5">
                      {group.label ? (
                        <h2 className="px-3 pb-0.5 text-xs font-medium text-muted-foreground/70">
                          {group.label}
                        </h2>
                      ) : null}
                      {group.entries.map((entry) => (
                        <PullRequestRow
                          key={pullRequestEntryKey(entry)}
                          entry={entry}
                          showProjectTitle
                          showProvider={showProvider}
                          selected={
                            selected?.repository === entry.repository &&
                            selected.number === entry.number
                          }
                          onSelect={selectEntry}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {listQuery.error && listData !== null ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                  <span>The latest request failed. Showing the last pull requests loaded.</span>
                  <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {listData?.truncated && entries.length > 0 ? (
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
            </div>
          </div>
        </div>

        {renderedSelection && environmentId !== null ? (
          <aside
            data-open={selected !== null}
            className={cn(
              "relative flex shrink-0 border-l border-border",
              "transition-[opacity,translate] duration-200 ease-out",
              "starting:translate-x-4 starting:opacity-0",
              "data-[open=false]:pointer-events-none data-[open=false]:translate-x-4 data-[open=false]:opacity-0",
            )}
            style={{ width: `${detailPanel.width}px` }}
          >
            <RightPanelResizeHandle handlers={detailPanel.handlers} />
            <PullRequestDetailPanel
              key={`${renderedSelection.repository}#${renderedSelection.number}`}
              environmentId={environmentId}
              reference={renderedSelection}
              onClose={() => updateSearch(clearedSelection)}
            />
          </aside>
        ) : null}
      </div>
    </SidebarInset>
  );
}
