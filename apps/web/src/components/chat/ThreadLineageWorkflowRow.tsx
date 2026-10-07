import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Wall clock for the phase: its members run in parallel, so the span from the
 * first start to the last finish is the time the phase actually took. Shaped
 * for AgentElapsed, which ticks it while the phase is still running.
 */
function phaseElapsed(phase: AgentPanelWorkflowGroup["phases"][number]) {
  const instants = (key: "startedAt" | "completedAt") =>
    phase.members
      .map((member) => member[key])
      .filter((value) => value !== null)
      .sort();
  const running = phase.state === "running";
  const startedAt = instants("startedAt")[0] ?? null;
  const completedAt = running ? null : (instants("completedAt").at(-1) ?? null);
  return {
    status: running ? ("running" as const) : ("completed" as const),
    // A settled phase whose members never reported an end has no span to show.
    startedAt: running || completedAt !== null ? startedAt : null,
    completedAt,
  };
}

const mutedDot = <span className="size-1.5 rounded-full bg-muted-foreground/50" />;

/**
 * Phase state as the panel already says it elsewhere: settled phases get a
 * check or cross, the running phase a ringed dot, so the active step is
 * findable without reading counts.
 */
function phaseStatus(phase: AgentPanelWorkflowGroup["phases"][number]) {
  if (phase.state === "running") {
    return {
      glyph: <span className="size-1.5 rounded-full bg-info ring-3 ring-info/20" />,
      label: "running",
    } as const;
  }
  if (phase.members.some((member) => member.status === "failed")) {
    return { glyph: <XIcon className="size-3 text-destructive" />, label: "failed" } as const;
  }
  if (
    phase.members.some((member) => member.status === "cancelled" || member.status === "interrupted")
  ) {
    return { glyph: mutedDot, label: "stopped" } as const;
  }
  if (phase.state === "done") {
    return { glyph: <CheckIcon className="size-3 text-success" />, label: "done" } as const;
  }
  return { glyph: mutedDot, label: "not started" } as const;
}

/**
 * A tree branch drawn by the list item itself: a line down its side, stopping
 * at the row's middle on the last item, and a tick into its 32px row.
 */
function branchClass(active: boolean) {
  return cn(
    "relative ps-3.5 before:absolute before:start-0 before:top-0 before:h-full before:w-px after:absolute after:start-0 after:top-4 after:h-px after:w-2.5 last:before:h-4",
    active ? "before:bg-info/35 after:bg-info/35" : "before:bg-border after:bg-border",
  );
}

/** Members run under the coordinator's provider, so they share its glyph. */
function WorkflowMemberRow({
  member,
  providerInstanceId,
  provider,
  providers,
  driver,
  onOpen,
  branchActive,
}: {
  member: RuntimeSubagent;
  providerInstanceId: ProviderInstanceId;
  provider: ServerProvider | undefined;
  providers: ReadonlyArray<ServerProvider> | undefined;
  driver: ProviderDriverKind | undefined;
  onOpen: (threadId: string) => void;
  branchActive: boolean;
}) {
  const threadId = member.childThreadId;
  const running = member.status === "running";
  return (
    <li className={cn("group", branchClass(branchActive))}>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              part="row"
              aria-label={`Open ${member.title} chat`}
              disabled={threadId === null}
              onClick={() => threadId !== null && onOpen(threadId)}
              className="h-8 min-w-0"
            />
          }
        >
          <ThreadRelationshipIcon driver={driver} provider={provider} status={member.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-normal",
              running ? "text-foreground/90" : "text-foreground/65",
            )}
          >
            {member.title}
          </span>
          <span className="sr-only">{member.status}</span>
          {member.startedAt ? (
            <span className="shrink-0 font-mono text-2xs font-normal tabular-nums text-muted-foreground">
              <AgentElapsed agent={member} />
            </span>
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            providerInstanceId={providerInstanceId}
            origin="provider_native"
            provider={provider}
            providers={providers}
            driver={driver}
            elapsed={<AgentElapsed agent={member} />}
            status={member.status}
            result={member.result ?? member.error}
            progress={member.progress}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

export function ThreadLineageWorkflowRow({
  group,
  header,
  providerInstanceId,
  provider,
  providers,
  driver,
  onOpenThread,
  onStop,
  stopping,
  stopDisabled,
}: {
  readonly group: AgentPanelWorkflowGroup;
  readonly header: ReactNode;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly onStop?: (() => void) | undefined;
  readonly stopping: boolean;
  readonly stopDisabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // The running phase opens itself until the user picks a side for it.
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const label = group.workflow.workflowName ?? group.workflow.title;
  const phases = group.phases.filter((phase) => phase.members.length > 0);
  return (
    // The flag lets the lineage list trade its compact height for the open tree.
    <li className="group" data-workflow-expanded={expanded ? "" : undefined}>
      <div className={cn("relative", THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS)}>
        {header}
        {onStop ? (
          <div className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    tone="destructive"
                    aria-label={`Stop workflow ${label}`}
                    disabled={stopDisabled}
                    onClick={onStop}
                  />
                }
              >
                {stopping ? (
                  <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                ) : (
                  <SquareIcon aria-hidden className="size-3 fill-current" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="left">Stop entire workflow</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="secondary"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </ThreadDetailsControl>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 ps-4.5">
          {phases.map((phase) => {
            const running = phase.state === "running";
            const open = phaseOpen.get(phase.index) ?? running;
            const status = phaseStatus(phase);
            return (
              <li key={phase.index} className={branchClass(false)}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setPhaseOpen((phases) => new Map(phases).set(phase.index, !open))}
                  className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-lg pe-2.5 text-left text-xs hover:bg-black/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 dark:hover:bg-white/[0.075]"
                >
                  <span aria-hidden className="flex w-4 shrink-0 justify-center">
                    {status.glyph}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      running ? "font-semibold text-foreground/90" : "text-muted-foreground",
                    )}
                  >
                    {phase.title}
                  </span>
                  <span
                    className={cn(
                      "w-18 shrink-0 text-end font-mono text-2xs tabular-nums",
                      running ? "text-info" : "text-muted-foreground/70",
                    )}
                  >
                    {phase.settledCount}/{phase.members.length}{" "}
                    {phase.members.length === 1 ? "agent" : "agents"}
                  </span>
                  <span className="w-14 shrink-0 text-end font-mono text-2xs text-muted-foreground/70">
                    <AgentElapsed agent={phaseElapsed(phase)} />
                  </span>
                  <span className="sr-only">{status.label}</span>
                </button>
                {open ? (
                  <ul className="m-0 list-none p-0 ps-2">
                    {phase.members.map((member) => (
                      <WorkflowMemberRow
                        key={member.id}
                        member={member}
                        providerInstanceId={providerInstanceId}
                        provider={provider}
                        providers={providers}
                        driver={driver}
                        onOpen={onOpenThread}
                        branchActive={running}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {group.unphasedMembers.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              member={member}
              providerInstanceId={providerInstanceId}
              provider={provider}
              providers={providers}
              driver={driver}
              onOpen={onOpenThread}
              branchActive={false}
            />
          ))}
          {phases.length === 0 && group.unphasedMembers.length === 0 ? (
            <li className="px-2.5 py-1.5 text-2xs text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
