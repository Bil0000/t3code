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
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
  pullRequestEntryKey,
} from "../components/pullRequest/pullRequestList.logic";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import {
  PullRequestFilterPills,
  PullRequestProjectFilter,
  PullRequestProviderFilter,
  PullRequestSearchInput,
  type PullRequestFilterOption,
} from "../components/pullRequest/PullRequestListFilters";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { RightPanelResizeHandle } from "../components/preview/RightPanelResizeHandle";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { useResizableWidth } from "../hooks/useResizableWidth";
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
  /** Narrows the list to one host. Absent means every host the workspace has. */
  readonly provider?: SourceControlProviderKind;
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

/** Accepted `provider` values in the URL, so an unknown one is dropped rather than sent on. */
const PROVIDER_KINDS = new Set<string>([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);

const PAGE_SIZE = 50;
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
    ...(typeof raw.provider === "string" && PROVIDER_KINDS.has(raw.provider)
      ? { provider: raw.provider as SourceControlProviderKind }
      : {}),
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
          ...(next.provider ? { provider: next.provider } : {}),
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

  // Page size is view state, not a URL concern: a shared link should open the first page.
  const filterKey = `${environmentId ?? ""}:${search.state}:${search.involvement}:${search.projectId ?? ""}:${search.provider ?? ""}`;
  const [page, setPage] = useState({ key: filterKey, size: PAGE_SIZE });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;

  const listQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId,
          input: {
            state: search.state,
            limit: pageSize,
            ...(search.projectId ? { projectId: search.projectId } : {}),
            ...(search.provider ? { provider: search.provider } : {}),
          },
        }),
  );

  // Raising the page size targets a different query, which starts empty. Holding the last
  // result for the same filters keeps the rows on screen so a longer page reads as growth
  // rather than a reload.
  const [loaded, setLoaded] = useState<{ key: string; data: PullRequestListResult } | null>(null);
  useEffect(() => {
    if (listQuery.data) setLoaded({ key: filterKey, data: listQuery.data });
  }, [filterKey, listQuery.data]);
  const listData = listQuery.data ?? (loaded?.key === filterKey ? loaded.data : null);
  const loadingMore = listQuery.isPending && listData !== null;
  const firstLoad = listQuery.isPending && listData === null;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // A failed page must stop the observer. Retained rows keep the sentinel on screen, so
    // re-arming it after a failure would ask for the next page again, forever.
    if (
      !sentinel ||
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
          setPage({ key: filterKey, size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE) });
        }
      },
      // Start the next page slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filterKey, listData?.truncated, listQuery.error, listQuery.isPending, pageSize]);

  const entries = useMemo(() => {
    const involvementEntries = filterPullRequestsByInvolvement(
      listData?.entries ?? [],
      listData?.viewers ?? EMPTY_VIEWERS,
      search.involvement,
    );
    return involvementEntries.filter((entry) => matchesPullRequestQuery(entry, search.q ?? ""));
  }, [listData, search.involvement, search.q]);

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
        (search.provider === undefined || project.repositoryIdentity.provider === search.provider),
    );
    return identity?.id;
  }, [projects, search.provider, search.repository]);

  // A project id in the URL outlives the environment it came from, and one from elsewhere can
  // never be read here — so it is dropped rather than passed on to fail every load.
  const linkedProjectId = useMemo(
    () =>
      search.selectedProjectId !== undefined &&
      projects.some((project) => project.id === search.selectedProjectId)
        ? search.selectedProjectId
        : undefined,
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
      search.provider === undefined || previous.length === 0 ? listData.providers : previous,
    );
  }, [listData, search.provider]);
  const showProvider = hosts.length > 1;
  // The workspace's own projects already name their hosts, so the row's shape is known before
  // the list is. Only its shape: which hosts can actually be read still comes from the server.
  const expectedHostCount = useMemo(
    () => new Set(projects.flatMap((project) => project.repositoryIdentity?.provider ?? [])).size,
    [projects],
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
                    value={search.provider}
                    expectedHostCount={expectedHostCount}
                    onChange={(provider) => updateSearch({ provider, ...clearedSelection })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <PullRequestSearchInput
                    value={search.q ?? ""}
                    onChange={(query) => updateSearch({ q: query || undefined })}
                  />
                  <PullRequestProjectFilter
                    projects={scopedProjects}
                    value={search.projectId}
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
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyTitle>No pull requests found</EmptyTitle>
                    <EmptyDescription>
                      Try another involvement, state, or search filter. Only projects on a host this
                      page can read are listed.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
              {listData?.errors.length ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                  {listData.errors.length}{" "}
                  {listData.errors.length === 1 ? "repository was" : "repositories were"}{" "}
                  unavailable. Healthy repositories are still shown.
                </p>
              ) : null}
              {listData?.truncated ? (
                <div
                  ref={sentinelRef}
                  className="flex justify-center py-2 text-xs text-muted-foreground"
                >
                  {loadingMore ? "Loading more pull requests..." : null}
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
