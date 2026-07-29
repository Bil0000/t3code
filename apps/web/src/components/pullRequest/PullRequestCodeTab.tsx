import { CodeView, type CodeViewDiffItem } from "@pierre/diffs/react";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Skeleton } from "../ui/skeleton";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";

/**
 * The pull request's patch, rendered with the same viewer as the thread diff panel. It renders
 * the remote patch only — review comments belong to a thread's composer, which this page has
 * no equivalent of, so the annotatable wrapper is deliberately not used here.
 */
export function PullRequestCodeTab({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const { resolvedTheme } = useTheme();
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({ environmentId, input: reference }),
  );

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
  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      files.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        const collapsed = collapsedFiles.has(fileKey);
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          collapsed,
          // The viewer re-renders an item only when its version changes, and collapsing is
          // the only thing that varies for a patch this page never edits.
          version: collapsed ? 1 : 0,
        };
      }),
    [collapsedFiles, files],
  );
  const lineStat = useMemo(() => getDiffLineStat(files), [files]);

  const toggleFile = (fileKey: string) =>
    setCollapsedFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });

  if (diffQuery.isPending && !diffQuery.data) {
    return (
      <div className="space-y-2 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (diffQuery.error) {
    return <p className="p-5 text-sm text-muted-foreground">{diffQuery.error}</p>;
  }

  // A patch the viewer cannot structure (binary, or a format it does not parse) still has to
  // be readable, so it falls back to the raw text rather than an empty tab.
  if (renderablePatch?.kind === "raw") {
    return (
      <div className="h-full space-y-2 overflow-auto p-5">
        <p className="text-xs text-muted-foreground">{renderablePatch.reason}</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">
          {renderablePatch.text}
        </pre>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="p-5 text-sm text-muted-foreground">This pull request has no file changes.</p>
    );
  }

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 flex-col">
        <PullRequestMetaLine className="shrink-0 border-b border-border/60 px-5 py-2 text-xs text-muted-foreground">
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <PullRequestDiffStat
            additions={lineStat.additions}
            deletions={lineStat.deletions}
            tone="diff"
          />
          {diffQuery.data?.truncated ? <span>diff truncated</span> : null}
        </PullRequestMetaLine>
        {/* The viewer renders at its natural height, so its host element is what scrolls —
            the same contract the thread diff panel uses. */}
        <div className="min-h-0 flex-1">
          <CodeView
            className="diff-render-surface h-full min-h-0 overflow-auto"
            items={items}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "wrap",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              stickyHeaders: true,
              itemMetrics: { diffHeaderHeight: 33 },
              layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
            }}
            renderHeaderPrefix={(item) => {
              const collapsed = collapsedFiles.has(item.id);
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
          />
        </div>
      </div>
    </DiffWorkerPoolProvider>
  );
}

export default PullRequestCodeTab;
