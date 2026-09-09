import type { GitCommitChangedFile, GitCommitDetails } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { CheckIcon, FileDiffIcon, RefreshCwIcon } from "lucide-react";
import { type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportCommitHashCopyFailure } from "./gitHistoryClipboard";
import { formatCommitDate } from "./GitHistoryCommitList";

const FILE_STATUS_COLORS = {
  A: "text-emerald-500",
  M: "text-amber-500",
  D: "text-red-500",
  R: "text-sky-500",
  C: "text-sky-500",
  T: "text-sky-500",
  U: "text-red-500",
  X: "text-muted-foreground",
  B: "text-muted-foreground",
} as const;

const FILE_STATUS_LABELS = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
  X: "Unknown",
  B: "Broken pairing",
} as const;

function CommitFilesTree(props: {
  files: ReadonlyArray<GitCommitChangedFile>;
  onShowDiff: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <LegendList<GitCommitChangedFile>
      data={props.files}
      keyExtractor={(file) => file.path}
      estimatedItemSize={24}
      drawDistance={192}
      recycleItems
      className="h-full"
      renderItem={({ item: file }) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded pr-1 text-left text-[0.6875rem] hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onClick={() => props.onShowDiff(file.path)}
                aria-label={`${FILE_STATUS_LABELS[file.status]} ${file.path}; show diff`}
              >
                <span
                  className={cn(
                    "w-3 shrink-0 font-mono font-semibold",
                    FILE_STATUS_COLORS[file.status],
                  )}
                >
                  {file.status}
                </span>
                <PierreEntryIcon
                  pathValue={file.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate">{file.path}</span>
              </button>
            }
          />
          <TooltipPopup>{`${FILE_STATUS_LABELS[file.status]} ${file.path}; show diff`}</TooltipPopup>
        </Tooltip>
      )}
    />
  );
}

export function CommitDetailsPane(props: {
  className?: string;
  style?: CSSProperties;
  id?: string;
  details: GitCommitDetails | null;
  files: ReadonlyArray<GitCommitChangedFile>;
  filesCapped: boolean;
  filesHasMore: boolean;
  filesError: boolean;
  filesLoading: boolean;
  onLoadMoreFiles: () => void;
  onRetryFiles: () => void;
  isPending: boolean;
  hasError: boolean;
  hasSelection: boolean;
  onRetry: () => void;
  onShowDiff: (hash: string, filePath?: string) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "commit hash",
    onError: reportCommitHashCopyFailure,
  });
  if (!props.hasSelection)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 items-center justify-center border-l border-border/60 px-6 text-center text-xs text-muted-foreground",
          props.className,
        )}
      >
        Select a commit to inspect its files and metadata.
      </aside>
    );
  if (props.hasError)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 flex-col items-center justify-center gap-3 border-l border-border/60 px-6 text-center text-xs text-destructive",
          props.className,
        )}
      >
        Could not load commit details.
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </aside>
    );
  if (props.isPending || props.details === null)
    return (
      <aside
        id={props.id}
        style={props.style}
        className={cn(
          "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 items-center justify-center border-l border-border/60 text-xs text-muted-foreground",
          props.className,
        )}
      >
        <RefreshCwIcon className="mr-2 size-3.5 animate-spin" /> Loading commit…
      </aside>
    );
  const details = props.details;
  return (
    <aside
      id={props.id}
      style={props.style}
      className={cn(
        "flex w-[32%] min-w-64 max-w-[26rem] shrink-0 flex-col border-l border-border/60 bg-muted/5",
        props.className,
      )}
    >
      <div className="shrink-0 border-b border-border/60 p-3 text-[0.6875rem]">
        <h2 className="text-sm font-semibold leading-5 text-foreground">{details.subject}</h2>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span>{details.authorName}</span>
          <span>{formatCommitDate(details.authoredAt)}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="font-mono text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => copyToClipboard(details.hash, undefined)}
                  aria-label={`Copy commit hash ${details.hash}`}
                >
                  {isCopied ? (
                    <CheckIcon className="inline size-3 text-success-foreground" />
                  ) : (
                    details.hash.slice(0, 8)
                  )}
                </button>
              }
            />
            <TooltipPopup>
              {isCopied ? "Commit hash copied" : `Copy full commit hash ${details.hash}`}
            </TooltipPopup>
          </Tooltip>
        </div>
        {details.refs.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {details.refs.map((ref) => (
              <span key={ref} className="text-[0.625rem] text-primary">
                {ref}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-b border-border/60">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 py-2 text-[0.6875rem] font-medium">
          <span>
            {props.files.length} loaded changed {props.files.length === 1 ? "file" : "files"}
          </span>
          <Button size="xs" variant="outline" onClick={() => props.onShowDiff(details.hash)}>
            <FileDiffIcon className="size-3" /> View all changes
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <CommitFilesTree
            files={props.files}
            onShowDiff={(path) => props.onShowDiff(details.hash, path)}
          />
          {props.filesError ? (
            <Button size="xs" variant="outline" onClick={props.onRetryFiles}>
              Retry loading changed files
            </Button>
          ) : null}
          {props.filesHasMore ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={props.onLoadMoreFiles}
              disabled={props.filesLoading}
            >
              {props.filesLoading ? "Loading more…" : "Load more"}
            </Button>
          ) : null}
          {props.filesCapped ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Changed-file list was capped.</p>
          ) : null}
        </div>
      </div>
      <div className="max-h-[34%] shrink-0 overflow-y-auto p-3 text-[0.6875rem]">
        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
          <dt>Commit</dt>
          <dd className="truncate font-mono text-foreground">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="max-w-full truncate text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={() => copyToClipboard(details.hash, undefined)}
                    aria-label={`Copy commit hash ${details.hash}`}
                  >
                    {details.hash}
                  </button>
                }
              />
              <TooltipPopup>
                {isCopied ? "Commit hash copied" : `Copy full commit hash ${details.hash}`}
              </TooltipPopup>
            </Tooltip>
          </dd>
          <dt>Email</dt>
          <dd className="truncate text-foreground">{details.authorEmail}</dd>
          <dt>Date</dt>
          <dd className="text-foreground">{formatCommitDate(details.authoredAt)}</dd>
          <dt>Parents</dt>
          <dd className="truncate font-mono text-foreground">
            {details.parentHashes.map((hash) => hash.slice(0, 8)).join(", ") || "None"}
          </dd>
        </dl>
        {details.body.trim().length > 0 ? (
          <p className="mt-4 whitespace-pre-wrap border-t border-border/50 pt-3 leading-5 text-foreground/85">
            {details.body.trim()}
          </p>
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">
        {isCopied ? `Copied commit hash ${details.hash}` : ""}
      </span>
    </aside>
  );
}
