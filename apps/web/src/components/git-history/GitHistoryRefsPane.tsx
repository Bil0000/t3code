import type { VcsHistoryRef } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { type CSSProperties, useMemo } from "react";

import type { GitRefTreeNode } from "../../lib/gitRefTree";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type RefNamespace = "heads" | "remotes" | "tags";

type RefPaneRow =
  | { readonly kind: "all"; readonly key: "all" }
  | { readonly kind: "current"; readonly key: "current" }
  | {
      readonly kind: "section";
      readonly key: string;
      readonly label: string;
      readonly count: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly label: string;
      readonly path: string;
      readonly depth: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "ref";
      readonly key: string;
      readonly node: Extract<GitRefTreeNode, { readonly kind: "ref" }>;
      readonly namespace: RefNamespace;
      readonly depth: number;
    }
  | { readonly kind: "empty"; readonly key: "empty" }
  | { readonly kind: "error"; readonly key: "error"; readonly message: string }
  | { readonly kind: "load-more"; readonly key: "load-more" };

function appendRefTreeRows(
  rows: RefPaneRow[],
  nodes: ReadonlyArray<GitRefTreeNode>,
  section: string,
  namespace: RefNamespace,
  expanded: ReadonlySet<string>,
  filterActive: boolean,
  depth = 0,
): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "ref") {
      count += 1;
      rows.push({ kind: "ref", key: `refs/${namespace}/${node.ref.name}`, node, namespace, depth });
      continue;
    }
    const key = `${section}:${node.path}`;
    const open = filterActive || expanded.has(key);
    rows.push({ kind: "folder", key, label: node.name, path: node.path, depth, open });
    if (open)
      count += appendRefTreeRows(
        rows,
        node.children,
        section,
        namespace,
        expanded,
        filterActive,
        depth + 1,
      );
    else count += countRefTreeRefs(node.children);
  }
  return count;
}

function countRefTreeRefs(nodes: ReadonlyArray<GitRefTreeNode>): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === "ref" ? 1 : countRefTreeRefs(node.children)),
    0,
  );
}

export function buildRefPaneRows(props: {
  readonly localRefTree: ReadonlyArray<GitRefTreeNode>;
  readonly remoteRefTree: ReadonlyArray<GitRefTreeNode>;
  readonly tagRefTree: ReadonlyArray<GitRefTreeNode>;
  readonly expandedRefKeys: ReadonlySet<string>;
  readonly filterActive: boolean;
  readonly hasMoreRefs: boolean;
  readonly refPaginationError: string | null;
}): ReadonlyArray<RefPaneRow> {
  const rows: RefPaneRow[] = [
    { kind: "all", key: "all" },
    { kind: "current", key: "current" },
  ];
  for (const section of [
    { label: "Local", section: "local", nodes: props.localRefTree, namespace: "heads" as const },
    {
      label: "Remote",
      section: "remote",
      nodes: props.remoteRefTree,
      namespace: "remotes" as const,
    },
    { label: "Tags", section: "tags", nodes: props.tagRefTree, namespace: "tags" as const },
  ]) {
    const open = props.filterActive || props.expandedRefKeys.has(`section:${section.section}`);
    const sectionRows: RefPaneRow[] = [];
    const count = open
      ? appendRefTreeRows(
          sectionRows,
          section.nodes,
          section.section,
          section.namespace,
          props.expandedRefKeys,
          props.filterActive,
        )
      : countRefTreeRefs(section.nodes);
    rows.push({
      kind: "section",
      key: `section:${section.section}`,
      label: section.label,
      count,
      open,
    });
    if (open) rows.push(...sectionRows);
  }
  if (
    props.filterActive &&
    props.localRefTree.length + props.remoteRefTree.length + props.tagRefTree.length === 0
  )
    rows.push({ kind: "empty", key: "empty" });
  if (props.refPaginationError)
    rows.push({ kind: "error", key: "error", message: props.refPaginationError });
  if (props.hasMoreRefs) rows.push({ kind: "load-more", key: "load-more" });
  return rows;
}

export function GitRefsPane(props: {
  className?: string;
  style?: CSSProperties;
  id?: string;
  refFilter: string;
  onRefFilterChange: (value: string) => void;
  selectedRevision: { label: string; revision: string } | null;
  onSelectAll: () => void;
  currentRef: VcsHistoryRef | null;
  onSelectRef: (label: string, revision: string) => void;
  normalizedRefFilter: string;
  localRefTree: ReadonlyArray<GitRefTreeNode>;
  remoteRefTree: ReadonlyArray<GitRefTreeNode>;
  tagRefTree: ReadonlyArray<GitRefTreeNode>;
  expandedRefKeys: ReadonlySet<string>;
  onToggleRefKey: (key: string) => void;
  hasMoreRefs: boolean;
  isFetchingMoreRefs: boolean;
  isRefSnapshotComplete: boolean;
  onLoadMoreRefs: () => void;
  refPaginationError: string | null;
  onRetryRefs: () => void;
  onClose?: () => void;
}) {
  const rows = useMemo(
    () =>
      buildRefPaneRows({
        localRefTree: props.localRefTree,
        remoteRefTree: props.remoteRefTree,
        tagRefTree: props.tagRefTree,
        expandedRefKeys: props.expandedRefKeys,
        filterActive: props.normalizedRefFilter.length > 0,
        hasMoreRefs: props.hasMoreRefs,
        refPaginationError: props.refPaginationError,
      }),
    [
      props.expandedRefKeys,
      props.hasMoreRefs,
      props.localRefTree,
      props.normalizedRefFilter,
      props.refPaginationError,
      props.remoteRefTree,
      props.tagRefTree,
    ],
  );
  return (
    <aside
      id={props.id}
      style={props.style}
      className={cn(
        "flex w-[24%] min-w-48 max-w-72 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/15",
        props.className,
      )}
      aria-label="Branches and tags"
    >
      {props.onClose ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-3">
          <span className="text-xs font-medium">Branches and tags</span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={props.onClose}
            aria-label="Close branches and tags"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div className="relative shrink-0 border-b border-border/50 p-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus={props.onClose ? true : undefined}
          className="h-7 w-full rounded border border-input bg-background/30 pr-2 pl-7 text-[0.6875rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          value={props.refFilter}
          onChange={(event) => props.onRefFilterChange(event.target.value)}
          placeholder="Branch or tag"
          aria-label="Filter branches and tags"
        />
      </div>
      {!props.isRefSnapshotComplete ? (
        <p
          role="status"
          className="shrink-0 border-b border-border/50 px-3 py-1.5 text-[0.625rem] text-muted-foreground"
        >
          Showing the first 10,000 matching refs.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 px-2 py-1">
        <LegendList<RefPaneRow>
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          estimatedItemSize={26}
          drawDistance={312}
          recycleItems
          className="h-full"
          renderItem={({ item: row }) => {
            if (row.kind === "all")
              return (
                <button
                  type="button"
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[0.6875rem] hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    props.selectedRevision === null && "bg-accent/70 font-medium text-foreground",
                  )}
                  onClick={props.onSelectAll}
                  aria-pressed={props.selectedRevision === null}
                >
                  <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
                  <span className="truncate">All refs</span>
                </button>
              );
            if (row.kind === "current")
              return (
                <button
                  type="button"
                  className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[0.6875rem] text-foreground/90 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                  disabled={props.currentRef === null}
                  onClick={() =>
                    props.currentRef &&
                    props.onSelectRef(props.currentRef.name, `refs/heads/${props.currentRef.name}`)
                  }
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">HEAD (Current Branch)</span>
                </button>
              );
            if (row.kind === "section")
              return (
                <button
                  type="button"
                  className="flex h-7 w-full items-center gap-1 px-1 text-left text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                  onClick={() => props.onToggleRefKey(row.key)}
                  aria-expanded={row.open}
                >
                  {row.open ? (
                    <ChevronDownIcon className="size-3" />
                  ) : (
                    <ChevronRightIcon className="size-3" />
                  )}
                  {row.label}
                  <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">
                    {row.count}
                  </span>
                </button>
              );
            if (row.kind === "folder")
              return (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[0.6875rem] text-foreground/80 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        style={{ paddingLeft: `${row.depth * 14 + 4}px` }}
                        onClick={() => props.onToggleRefKey(row.key)}
                        aria-expanded={row.open}
                      >
                        {row.open ? (
                          <ChevronDownIcon className="size-3 shrink-0" />
                        ) : (
                          <ChevronRightIcon className="size-3 shrink-0" />
                        )}
                        {row.open ? (
                          <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{row.label}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{row.path}</TooltipPopup>
                </Tooltip>
              );
            if (row.kind === "ref") {
              const revision = `refs/${row.namespace}/${row.node.ref.name}`;
              const selected = props.selectedRevision?.revision === revision;
              const aheadCount = row.node.ref.aheadCount ?? 0;
              const behindCount = row.node.ref.behindCount ?? 0;
              const upstreamName = row.node.ref.upstreamName ?? "the configured upstream";
              const syncDescription = [
                aheadCount > 0 ? `${aheadCount} commits ahead of upstream ${upstreamName}` : null,
                behindCount > 0 ? `${behindCount} commits behind upstream ${upstreamName}` : null,
              ]
                .filter((description): description is string => description !== null)
                .join(". ");
              return (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className={cn(
                          "flex h-6 w-full min-w-0 items-center gap-1.5 rounded px-1 text-left text-[0.6875rem] text-foreground/80 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          selected && "bg-accent/70 font-medium text-foreground",
                        )}
                        style={{ paddingLeft: `${row.depth * 14 + 20}px` }}
                        onClick={() => props.onSelectRef(row.node.ref.name, revision)}
                        aria-pressed={selected}
                        aria-label={
                          syncDescription
                            ? `${row.node.ref.name}. ${syncDescription}.`
                            : row.node.ref.name
                        }
                      >
                        {row.node.ref.isDefault ? (
                          <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                        ) : row.namespace === "tags" ? (
                          <TagIcon className="size-3 shrink-0 text-amber-400" />
                        ) : (
                          <GitBranchIcon
                            className={cn(
                              "size-3 shrink-0",
                              row.node.ref.current && "text-foreground",
                            )}
                          />
                        )}
                        <span className="truncate">{row.node.name}</span>
                        {aheadCount > 0 || behindCount > 0 ? (
                          <span className="ml-auto flex shrink-0 items-center gap-1 text-[0.5625rem]">
                            {aheadCount > 0 ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="flex items-center text-emerald-400">
                                      <ArrowUpIcon className="size-2.5" />
                                      {aheadCount > 99 ? "99+" : aheadCount}
                                    </span>
                                  }
                                />
                                <TooltipPopup>{`${aheadCount} commits ahead of ${upstreamName}`}</TooltipPopup>
                              </Tooltip>
                            ) : null}
                            {behindCount > 0 ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="flex items-center text-sky-400">
                                      <ArrowDownIcon className="size-2.5" />
                                      {behindCount > 99 ? "99+" : behindCount}
                                    </span>
                                  }
                                />
                                <TooltipPopup>{`${behindCount} commits behind ${upstreamName}`}</TooltipPopup>
                              </Tooltip>
                            ) : null}
                          </span>
                        ) : null}
                      </button>
                    }
                  />
                  <TooltipPopup>{row.node.ref.name}</TooltipPopup>
                </Tooltip>
              );
            }
            if (row.kind === "empty")
              return (
                <p className="px-2 py-4 text-center text-[0.6875rem] text-muted-foreground">
                  No matching branches or tags.
                </p>
              );
            if (row.kind === "error")
              return (
                <div className="mt-2 flex items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[0.6875rem] text-destructive">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 truncate">{row.message}</span>}
                    />
                    <TooltipPopup>{row.message}</TooltipPopup>
                  </Tooltip>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    onClick={props.onRetryRefs}
                  >
                    Retry refs
                  </Button>
                </div>
              );
            return (
              <Button
                size="xs"
                variant="ghost"
                className="mt-2 w-full"
                onClick={props.onLoadMoreRefs}
                disabled={props.isFetchingMoreRefs}
              >
                {props.isFetchingMoreRefs ? "Loading more refs…" : "Load more refs"}
              </Button>
            );
          }}
        />
      </div>
    </aside>
  );
}
