/**
 * Lineage row for a workflow coordinator. It unfolds in place — phases, then
 * one line per member — because a run's members are invisible anywhere else.
 */
import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { THREAD_DETAILS_PANEL_LINK_ROW_CLASS } from "./threadDetailsPanelStyles";

function MemberRow({
  member,
  onOpen,
}: {
  member: RuntimeSubagent;
  onOpen: (threadId: string) => void;
}) {
  const threadId = member.childThreadId;
  return (
    // Flex so the row button's flex-1 has something to stretch against;
    // without it the button shrink-wraps and the elapsed time floats mid-row.
    <li className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        disabled={threadId === null}
        onClick={() => threadId !== null && onOpen(threadId)}
        className={cn(
          THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
          "h-9 gap-2 pl-7 pr-2.5 text-[13px] font-medium sm:h-9 sm:text-[13px]",
        )}
      >
        <ThreadRelationshipIcon status={member.status} />
        <span className="min-w-0 flex-1 truncate text-left">{member.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <AgentElapsed agent={member} />
        </span>
      </Button>
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
    <li>
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={
          <span className="tabular-nums">
            {phase.settledCount}/{phase.members.length} settled
          </span>
        }
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
    <li className="group">
      <div className="flex h-9 items-center rounded-lg">
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
          {/* Reachable: coordinator, or declared phases, with no members yet. */}
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
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {settled}/{members.length} settled
    </span>
  );
}
