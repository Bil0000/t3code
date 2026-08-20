import type { GitHistoryCommit } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleDotIcon,
  CloudIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  TagIcon,
} from "lucide-react";
import * as Cause from "effect/Cause";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { GitHistoryGraphRow } from "../../lib/gitHistoryGraph";
import { cn } from "../../lib/utils";
import { reportCommitHashCopyFailure } from "./gitHistoryClipboard";
import type { CommitRefKind, GitHistoryRow } from "./GitHistoryVisualTypes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const GIT_HISTORY_ROW_HEIGHT_REM = 1.875;
const DEFAULT_INTERFACE_FONT_SIZE = 16;
export const GIT_HISTORY_ROW_HEIGHT = GIT_HISTORY_ROW_HEIGHT_REM * DEFAULT_INTERFACE_FONT_SIZE;
const LANE_WIDTH = 11;
const GRAPH_HORIZONTAL_PADDING = 6;
const MAX_GRAPH_WIDTH = 104;
const GRAPH_COLORS = ["#4f9cff", "#b26cff", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6"] as const;

export function queryErrorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not load Git history.";
}

export function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const now = new Date();
  const elapsedMs = now.valueOf() - date.valueOf();
  if (elapsedMs >= 0 && elapsedMs < 60 * 60 * 1_000) {
    const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${time}`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

function pullRequestNumberFromSubject(subject: string): string | null {
  return /^Merge pull request #(\d+)\b/i.exec(subject)?.[1] ?? null;
}

function CommitRefDecoration(props: {
  refName: string;
  refKinds: ReadonlyMap<string, CommitRefKind>;
}) {
  const refTarget = props.refName.split(" -> ", 1)[0] ?? props.refName;
  const explicitTag = props.refName.startsWith("tag: ");
  const label = explicitTag ? props.refName.slice(5) : props.refName;
  const kind = props.refName.startsWith("HEAD -> ")
    ? "head"
    : explicitTag
      ? "tag"
      : (props.refKinds.get(refTarget) ?? "unknown");
  const Icon =
    kind === "head"
      ? CircleDotIcon
      : kind === "remote"
        ? CloudIcon
        : kind === "tag"
          ? TagIcon
          : GitBranchIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
            <Icon
              className={cn(
                "size-3 shrink-0",
                kind === "head" && "text-sky-400",
                kind === "local" && "text-violet-400",
                kind === "remote" && "text-cyan-400",
                kind === "tag" && "text-amber-400",
              )}
            />
            <span className="truncate">{label}</span>
          </span>
        }
      />
      <TooltipPopup>{`${kind === "head" ? "HEAD" : kind === "remote" ? "Remote branch" : kind === "tag" ? "Tag" : kind === "local" ? "Local branch" : "Unresolved branch"}: ${label}`}</TooltipPopup>
    </Tooltip>
  );
}

export function graphColumnWidth(laneCount: number): number {
  return Math.min(
    Math.max(LANE_WIDTH * laneCount + GRAPH_HORIZONTAL_PADDING * 2, 44),
    MAX_GRAPH_WIDTH,
  );
}

export function gitHistoryRowHeight(interfaceFontSize: number): number {
  return GIT_HISTORY_ROW_HEIGHT_REM * interfaceFontSize;
}

export function currentHeadHash(commits: ReadonlyArray<GitHistoryCommit>): string | undefined {
  return (
    commits.find((commit) =>
      commit.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> ")),
    )?.hash ?? commits[0]?.hash
  );
}

export function firstParentHashes(
  commits: ReadonlyArray<GitHistoryCommit>,
  headHash: string | undefined,
): ReadonlySet<string> {
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const hashes = new Set<string>();
  let hash = headHash;
  while (hash && !hashes.has(hash)) {
    hashes.add(hash);
    hash = commitsByHash.get(hash)?.parentHashes[0];
  }
  return hashes;
}

function CommitSubject({ subject, issueUrlPrefix }: { subject: string; issueUrlPrefix?: string }) {
  const issueReferences = Array.from(subject.matchAll(/#[0-9]+/g));
  let textEnd = 0;
  const references = issueReferences.flatMap((reference) => {
    const part = reference[0];
    const start = reference.index ?? 0;
    const text = subject.slice(textEnd, start);
    textEnd = start + part.length;
    const className = "font-semibold text-violet-400 hover:text-violet-300 hover:underline";
    const referenceElement = issueUrlPrefix ? (
      <Tooltip key={`${start}:${part}`}>
        <TooltipTrigger
          render={
            <a
              className={`${className} pointer-events-auto`}
              href={`${issueUrlPrefix}${part.slice(1)}`}
              target="_blank"
              rel="noreferrer"
            >
              {part}
            </a>
          }
        />
        <TooltipPopup>{`Open ${part} on GitHub`}</TooltipPopup>
      </Tooltip>
    ) : (
      <span key={`${start}:${part}`} className={className}>
        {part}
      </span>
    );
    return [text, referenceElement];
  });
  return [...references, subject.slice(textEnd)];
}

function GraphCell(props: {
  graph: GitHistoryGraphRow;
  laneCount: number;
  rowHeight: number;
  selected: boolean;
  current: boolean;
}) {
  const width = graphColumnWidth(props.laneCount);
  const centerY = props.rowHeight / 2;
  const laneWidth = Math.min(
    LANE_WIDTH,
    (width - GRAPH_HORIZONTAL_PADDING * 2) / Math.max(props.laneCount, 1),
  );
  const x = (lane: number) => lane * laneWidth + GRAPH_HORIZONTAL_PADDING + laneWidth / 2;
  const { edges } = props.graph;
  return (
    <div
      aria-hidden="true"
      data-git-graph={props.graph.hash}
      className="relative h-full shrink-0"
      style={{ width }}
    >
      <svg
        className="absolute inset-0"
        viewBox={`0 0 ${width} ${props.rowHeight}`}
        width={width}
        height={props.rowHeight}
      >
        {props.graph.hasIncoming ? (
          <line
            x1={x(props.graph.lane)}
            y1="0"
            x2={x(props.graph.lane)}
            y2={centerY}
            stroke={GRAPH_COLORS[props.graph.colorIndex % GRAPH_COLORS.length]}
            strokeWidth="1.1"
            strokeLinecap="square"
          />
        ) : null}
        {edges.map((edge) => {
          const fromX =
            edge.kind === "parent" || edge.kind === "elided"
              ? x(props.graph.lane)
              : x(edge.fromLane);
          const fromY = edge.kind === "parent" || edge.kind === "elided" ? centerY : 0;
          const toX = x(edge.toLane);
          const path =
            edge.kind === "continuation"
              ? `M ${fromX} 0 L ${toX} ${props.rowHeight}`
              : edge.kind === "incoming"
                ? `M ${fromX} 0 L ${fromX} ${centerY * 0.45} L ${toX} ${centerY}`
                : edge.kind === "elided"
                  ? `M ${fromX} ${fromY} L ${toX} ${centerY} L ${toX} ${props.rowHeight}`
                  : `M ${fromX} ${fromY} L ${toX} ${props.rowHeight}`;
          return (
            <path
              data-edge-kind={edge.kind}
              key={`${edge.kind}:${edge.fromLane}:${edge.toLane}:${edge.colorIndex}:${edge.parentHash ?? ""}`}
              d={path}
              fill="none"
              stroke={GRAPH_COLORS[edge.colorIndex % GRAPH_COLORS.length]}
              strokeWidth="1.1"
              strokeLinecap={edge.isMissingParent || edge.kind === "elided" ? "butt" : "square"}
              strokeDasharray={edge.isMissingParent || edge.kind === "elided" ? "3 2" : undefined}
            />
          );
        })}
        <circle
          data-commit-node={props.graph.hash}
          data-current-head={props.current || undefined}
          cx={x(props.graph.lane)}
          cy={centerY}
          r={props.selected ? 5 : 4}
          fill={
            props.current
              ? "var(--background)"
              : GRAPH_COLORS[props.graph.colorIndex % GRAPH_COLORS.length]
          }
          stroke={
            props.current ? GRAPH_COLORS[props.graph.colorIndex % GRAPH_COLORS.length] : undefined
          }
          strokeWidth={props.current ? 1.6 : undefined}
          className="transition-[r]"
        />
      </svg>
    </div>
  );
}

export function CommitRow(props: {
  row: GitHistoryRow;
  laneCount: number;
  rowHeight?: number;
  refKinds: ReadonlyMap<string, CommitRefKind>;
  issueUrlPrefix?: string;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  const { commit } = props.row;
  const rowHeight = props.rowHeight ?? GIT_HISTORY_ROW_HEIGHT;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "commit hash",
    onError: reportCommitHashCopyFailure,
  });
  const pullRequestNumber = pullRequestNumberFromSubject(commit.subject);
  const isMergeCommit = commit.parentHashes.length > 1 || /^Merge\b/i.test(commit.subject);
  return (
    <div
      className={cn(
        "group relative flex w-full min-w-0 items-stretch text-left transition-colors hover:bg-accent/45",
        props.selected && "bg-accent/70",
      )}
      style={{ height: rowHeight }}
    >
      <button
        type="button"
        data-commit-hash={commit.hash}
        className="absolute inset-0 z-0 outline-none focus-visible:bg-accent/60"
        onClick={() => props.onSelect(commit.hash)}
        aria-pressed={props.selected}
        aria-label={`${commit.subject || "No subject"}. Author ${commit.authorName}, ${formatCommitDate(commit.authoredAt)}. ${isMergeCommit ? `${commit.parentHashes.length}-parent merge commit.` : commit.parentHashes.length === 1 ? "One parent." : "Root commit."} ${commit.refs.length > 0 ? `Refs: ${commit.refs.join(", ")}.` : ""}`}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-stretch">
        <GraphCell
          graph={props.row.graph}
          laneCount={props.laneCount}
          rowHeight={rowHeight}
          selected={props.selected}
          current={commit.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "))}
        />
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)_minmax(5rem,7rem)_8.5rem] items-center gap-x-3 border-b border-border/45 pr-3 text-xs @max-[720px]:grid-cols-[minmax(10rem,1fr)]">
          <div className="min-w-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "block truncate font-medium",
                      isMergeCommit ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {commit.subject ? (
                      <CommitSubject
                        subject={commit.subject}
                        {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
                      />
                    ) : (
                      "(no subject)"
                    )}
                  </span>
                }
              />
              <TooltipPopup>{commit.subject}</TooltipPopup>
            </Tooltip>
          </div>
          <div className="flex min-w-0 justify-end gap-2 overflow-hidden @max-[720px]:hidden">
            {pullRequestNumber ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex shrink-0 items-center gap-1 text-[0.625rem] text-violet-400">
                      <GitPullRequestIcon className="size-3" />#{pullRequestNumber}
                    </span>
                  }
                />
                <TooltipPopup>{`Pull request #${pullRequestNumber}`}</TooltipPopup>
              </Tooltip>
            ) : null}
            {commit.refs.slice(0, 3).map((ref) => (
              <CommitRefDecoration key={ref} refName={ref} refKinds={props.refKinds} />
            ))}
            {commit.refs.length > 3 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                      +{commit.refs.length - 3}
                    </span>
                  }
                />
                <TooltipPopup>{commit.refs.slice(3).join("\n")}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="truncate text-muted-foreground @max-[720px]:hidden">
                  {commit.authorName}
                </span>
              }
            />
            <TooltipPopup>{commit.authorName}</TooltipPopup>
          </Tooltip>
          <span className="truncate text-muted-foreground @max-[720px]:hidden">
            {formatCommitDate(commit.authoredAt)}
          </span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="relative z-20 flex w-20 shrink-0 items-center justify-center gap-1 font-mono text-[0.625rem] text-muted-foreground tabular-nums outline-none transition-colors hover:text-foreground focus-visible:bg-accent/60 focus-visible:text-foreground"
              onClick={() => copyToClipboard(commit.hash, undefined)}
              aria-label={`Copy commit hash ${commit.hash}`}
            >
              {isCopied ? (
                <>
                  <CheckIcon className="size-3 text-success-foreground" />
                  Copied
                </>
              ) : (
                commit.hash.slice(0, 8)
              )}
            </button>
          }
        />
        <TooltipPopup>
          {isCopied ? "Commit hash copied" : `Copy full commit hash ${commit.hash}`}
        </TooltipPopup>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {isCopied ? `Copied commit hash ${commit.hash}` : ""}
      </span>
    </div>
  );
}
