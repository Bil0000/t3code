import type {
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestState,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
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
  PullRequestSearchInput,
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
  readonly state: PullRequestState;
  /** Scopes the list. Separate from the selection so one cannot silently change the other. */
  readonly projectId?: ProjectId;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly q?: string;
}

const INVOLVEMENT_TABS = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Reviewing" },
  { value: "authored", label: "Authored" },
] as const satisfies ReadonlyArray<{ value: PullRequestInvolvement; label: string }>;

const STATE_TABS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
] as const satisfies ReadonlyArray<{ value: PullRequestState; label: string }>;

const PAGE_SIZE = 50;
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
    state: raw.state === "closed" || raw.state === "merged" ? raw.state : "open",
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
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
  const projects = useProjects();
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
  const filterKey = `${search.state}:${search.involvement}:${search.projectId ?? ""}`;
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

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || listData?.truncated !== true || listQuery.isPending) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) {
          setPage({ key: filterKey, size: pageSize + PAGE_SIZE });
        }
      },
      // Start the next page slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filterKey, listData?.truncated, listQuery.isPending, pageSize]);

  const entries = useMemo(() => {
    const involvementEntries = filterPullRequestsByInvolvement(
      listData?.entries ?? [],
      listData?.viewer ?? null,
      search.involvement,
    );
    return involvementEntries.filter((entry) => matchesPullRequestQuery(entry, search.q ?? ""));
  }, [listData, search.involvement, search.q]);

  const groups = useMemo(
    () =>
      search.involvement === "all"
        ? groupPullRequestsByInvolvement(entries, listData?.viewer ?? null)
        : [{ key: "others" as const, label: "", entries }],
    [entries, listData?.viewer, search.involvement],
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
          repository,
    );
    return identity?.id;
  }, [projects, search.repository]);

  const selectedProjectId = search.selectedProjectId ?? projectIdForRepository;
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
            <h1 className="truncate text-sm font-medium">Pull requests</h1>
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

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 pb-12 pt-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PullRequestFilterPills
                    value={search.involvement}
                    options={INVOLVEMENT_TABS}
                    onChange={(involvement) => updateSearch({ involvement, ...clearedSelection })}
                  />
                  <PullRequestFilterPills
                    value={search.state}
                    options={STATE_TABS}
                    onChange={(state) => updateSearch({ state, ...clearedSelection })}
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

              {listQuery.isPending && listData === null ? (
                <div className="space-y-1">
                  {Array.from({ length: 7 }, (_, index) => (
                    <Skeleton key={index} className="h-13 w-full rounded-lg" />
                  ))}
                </div>
              ) : listQuery.error ? (
                <PullRequestsUnavailableState
                  error={listQuery.error}
                  onRetry={() => listQuery.refresh()}
                />
              ) : entries.length === 0 ? (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyTitle>No pull requests found</EmptyTitle>
                    <EmptyDescription>
                      Try another involvement, state, or search filter. Only projects backed by a
                      GitHub repository are listed.
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
