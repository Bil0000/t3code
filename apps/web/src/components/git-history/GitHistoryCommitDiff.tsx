import type { GitCommitChangedFile } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { FileDiffIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import {
  getRenderablePatch,
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function CommitDiffView(props: {
  hash: string;
  filePath?: string;
  files: ReadonlyArray<GitCommitChangedFile>;
  diff: string | null;
  truncated: boolean;
  isPending: boolean;
  error: string | null;
  onBack: () => void;
  onSelectFile: (filePath?: string) => void;
  onRetry: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const renderable = useMemo(
    () =>
      getRenderablePatch(
        props.diff ?? undefined,
        `git-history:${props.hash}:${props.filePath ?? "all"}`,
      ),
    [props.diff, props.filePath, props.hash],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Button size="xs" variant="ghost" onClick={props.onBack}>
          Back to history
        </Button>
        <FileDiffIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate text-xs font-medium">
          {props.filePath ?? `Commit ${props.hash.slice(0, 8)}`}
        </span>
        <label className="ml-auto flex min-w-0 items-center gap-2 text-[0.625rem] text-muted-foreground">
          <span className="shrink-0">
            {props.filePath
              ? `${Math.max(1, props.files.findIndex((file) => file.path === props.filePath) + 1)} of ${props.files.length}`
              : `${props.files.length} files`}
          </span>
          <Select
            value={props.filePath ?? ""}
            onValueChange={(value) => props.onSelectFile(value || undefined)}
          >
            <SelectTrigger size="xs" className="max-w-64" aria-label="Select changed file">
              <SelectValue>{props.filePath ?? "All changed files"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All changed files</SelectItem>
              {props.files.map((file) => (
                <SelectItem key={file.path} value={file.path}>
                  {file.path}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        {props.truncated ? <span className="text-[0.625rem] text-amber-400">truncated</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {props.isPending ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <RefreshCwIcon className="mr-2 size-3.5 animate-spin" /> Loading diff…
          </div>
        ) : props.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-destructive">
            <span>{props.error}</span>
            <Button size="xs" variant="outline" onClick={props.onRetry}>
              Retry
            </Button>
          </div>
        ) : renderable?.kind === "files" ? (
          <div className="diff-render-surface space-y-2">
            {renderable.files.map((fileDiff) => (
              <div key={resolveFileDiffPath(fileDiff)}>
                <FileDiff
                  fileDiff={fileDiff}
                  options={{
                    collapsed: false,
                    diffStyle: "unified",
                    lineDiffType: "none",
                    overflow: "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
                  }}
                />
                {fileDiff.hunks.length === 0 ? (
                  <div className="border-x border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    Binary or metadata-only change; no textual diff is available.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : renderable?.kind === "raw" ? (
          <pre className="overflow-auto whitespace-pre font-mono text-xs">{renderable.text}</pre>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            This commit has no textual diff.
          </div>
        )}
      </div>
    </div>
  );
}
