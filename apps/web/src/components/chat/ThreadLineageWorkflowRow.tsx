import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const STATUS_LABELS: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

function MemberRow({
  member,
  onOpen,
}: {
  member: RuntimeSubagent;
  onOpen: (threadId: string) => void;
}) {
  const threadId = member.childThreadId;
  const working = ["pending", "running", "waiting"].includes(member.status);
  const status = STATUS_LABELS[member.status];
  const activity = working
    ? (member.progress ?? member.result ?? member.error)
    : (member.error ?? member.result ?? member.progress);
  const metadata = [
    formatSubagentModelLabel(member.model, member.effort),
    member.usage ? `${formatSubagentTokenCount(member.usage.totalTokens)} tok` : null,
    member.usage?.toolUses !== undefined ? `${member.usage.toolUses} tools` : null,
    member.activationCount > 1 ? `run ${member.activationCount}` : null,
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${member.title} chat`}
        disabled={threadId === null}
        onClick={() => threadId !== null && onOpen(threadId)}
        className="grid w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-55"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            working
              ? "bg-info"
              : member.status === "failed"
                ? "bg-destructive"
                : member.status === "completed"
                  ? "bg-success"
                  : "bg-muted-foreground/50",
          )}
        />
        <span className="min-w-0 truncate text-sm font-medium">{member.title}</span>
        <span className="text-right font-mono text-[.7rem] text-muted-foreground/80">
          <AgentElapsed agent={member} />
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 truncate text-xs",
            member.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {activity || status}
        </span>
        <span className="col-start-2 col-end-4 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
          {metadata.join(" · ")}
        </span>
        <span className="sr-only">{status}</span>
      </button>
    </li>
  );
}

function PhaseRows({
  phase,
  onOpen,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  onOpen: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (phase.members.length === 0) return null;
  return (
    <li className="mt-1">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={
          <span className="tabular-nums">
            {phase.settledCount}/{phase.members.length} settled
          </span>
        }
        tone={phase.state === "running" ? "info" : "emphasized"}
      >
        {phase.title}
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul className="m-0 list-none p-0">
          {phase.members.map((member) => (
            <MemberRow key={member.id} member={member} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ThreadLineageWorkflowRow(props: {
  readonly group: AgentPanelWorkflowGroup;
  readonly header: ReactNode;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { group } = props;
  const label = group.workflow.workflowName ?? group.workflow.title;
  const hasMembers =
    group.unphasedMembers.length > 0 || group.phases.some((phase) => phase.members.length > 0);
  return (
    <li data-workflow className="group rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex min-h-12 items-center">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          onClick={() => setExpanded((value) => !value)}
          className="size-5 shrink-0 border-transparent bg-transparent p-0 text-muted-foreground sm:size-5"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </Button>
        {props.header}
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 pb-1">
          {group.phases.map((phase) => (
            <PhaseRows key={phase.index} phase={phase} onOpen={props.onOpenThread} />
          ))}
          {group.unphasedMembers.map((member) => (
            <MemberRow key={member.id} member={member} onOpen={props.onOpenThread} />
          ))}
          {!hasMembers ? (
            <li className="px-7 py-1 text-[11px] text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function ThreadLineageWorkflowCount({ group }: { group: AgentPanelWorkflowGroup }) {
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  return (
    <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
      {settled}/{members.length} settled
    </span>
  );
}
