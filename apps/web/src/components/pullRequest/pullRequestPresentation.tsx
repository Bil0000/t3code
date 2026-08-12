import type {
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

import {
  SourceControlActorAvatar,
  SourceControlActorLabel,
  SourceControlMetaLine,
} from "../sourceControl/actorPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const PullRequestActorAvatar = SourceControlActorAvatar;
export const PullRequestActorLabel = SourceControlActorLabel;
export const PullRequestMetaLine = SourceControlMetaLine;

interface StatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: typeof GitPullRequestIcon;
}

/**
 * How a pull request's state reads on this page. Open, closed and merged use the same ink as
 * the thread badge in `ThreadStatusIndicators`, so one pull request cannot look like two
 * different things in two places; draft and conflicts are states that badge never shows.
 *
 * Draft outranks conflicts: a draft is not heading for a merge yet, so conflicts only surface
 * once it is real work.
 */
export function resolvePullRequestState(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
  readonly baseBranch?: string;
}): StatePresentation {
  if (input.state === "merged") {
    return {
      label: "Merged",
      toneClassName: "text-violet-600 dark:text-violet-300/90",
      Icon: GitMergeIcon,
    };
  }
  if (input.state === "closed") {
    return {
      label: "Closed",
      toneClassName: "text-red-600 dark:text-red-300/90",
      Icon: GitPullRequestClosedIcon,
    };
  }
  if (input.isDraft) {
    return {
      label: "Draft",
      toneClassName: "text-zinc-500 dark:text-zinc-400/80",
      Icon: GitPullRequestDraftIcon,
    };
  }
  if (input.mergeability === "conflicting") {
    return {
      // "Has conflicts" leaves out the one thing a reader wants when the warning triangle catches
      // their eye, so name the branch it collides with wherever the caller knows it.
      label: input.baseBranch ? `Conflicts with ${input.baseBranch}` : "Has conflicts",
      toneClassName: "text-destructive",
      Icon: TriangleAlertIcon,
    };
  }
  return {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: GitPullRequestIcon,
  };
}

export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
  baseBranch,
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  mergeability?: PullRequestMergeability;
  baseBranch?: string;
  className?: string;
}) {
  const presentation = resolvePullRequestState({
    state,
    isDraft,
    ...(mergeability ? { mergeability } : {}),
    ...(baseBranch ? { baseBranch } : {}),
  });
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span: an interactive one would
          nest a control inside that button and steal the row's click target. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

const CHECK_STATUS_PRESENTATION = {
  pending: { label: "Running", Icon: LoaderIcon, toneClassName: "animate-spin text-amber-500" },
  success: {
    label: "Passed",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  failure: { label: "Failed", Icon: CircleXIcon, toneClassName: "text-destructive" },
  cancelled: { label: "Cancelled", Icon: CircleXIcon, toneClassName: "text-destructive" },
  skipped: { label: "Skipped", Icon: CircleDashedIcon, toneClassName: "text-muted-foreground/70" },
  neutral: { label: "Neutral", Icon: CircleDashedIcon, toneClassName: "text-muted-foreground/70" },
} as const satisfies Record<
  PullRequestCheckStatus,
  { label: string; Icon: typeof CircleCheckIcon; toneClassName: string }
>;

export function pullRequestCheckStatusLabel(status: PullRequestCheckStatus): string {
  return CHECK_STATUS_PRESENTATION[status].label;
}

export function PullRequestCheckStatusIcon({ status }: { status: PullRequestCheckStatus }) {
  const presentation = CHECK_STATUS_PRESENTATION[status];
  return (
    <presentation.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

/** Added and removed lines, coloured the way every host colours them. */
export function PullRequestDiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  // Not every host reports line counts. Showing "+0 -0" would read as an empty change set
  // rather than as a missing one, so the stat is left out instead.
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return (
    <span className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}>
      <span className="text-emerald-600 dark:text-emerald-300/90">
        +{additions.toLocaleString()}
      </span>
      <span className="text-destructive">-{deletions.toLocaleString()}</span>
    </span>
  );
}

export function summarizePullRequestChecks(checks: ReadonlyArray<PullRequestCheck>): string {
  if (checks.length === 0) return "No checks reported";
  const failed = checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  ).length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passed = checks.filter((check) => check.status === "success").length;
  if (failed > 0) return `${failed} of ${checks.length} failing`;
  if (pending > 0) return `${pending} of ${checks.length} running`;
  return passed === checks.length ? "All checks passed" : `${passed} of ${checks.length} passing`;
}
