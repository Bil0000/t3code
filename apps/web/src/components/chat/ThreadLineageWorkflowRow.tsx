import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const PHASE_CONTROL_CLASS =
  "flex h-7 w-full cursor-pointer items-center justify-end rounded-md px-2.5 text-[10px] font-medium text-muted-foreground/65 hover:bg-black/[0.055] hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 dark:hover:bg-white/[0.075]";

/** Members run under the coordinator's provider, so they share its glyph. */
function WorkflowMemberRow({
  member,
  provider,
  driver,
  onOpen,
}: {
  member: RuntimeSubagent;
  provider: ServerProvider | undefined;
  driver: ProviderDriverKind | undefined;
  onOpen: (threadId: string) => void;
}) {
  const threadId = member.childThreadId;
  return (
    <li className="group">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Open ${member.title} chat`}
              disabled={threadId === null}
              onClick={() => threadId !== null && onOpen(threadId)}
              className={cn(THREAD_DETAILS_PANEL_LINK_ROW_CLASS, "w-full")}
            />
          }
        >
          <ThreadRelationshipIcon driver={driver} provider={provider} status={member.status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground/85">
            {member.title}
          </span>
          <span className="sr-only">{member.status}</span>
          {member.startedAt ? (
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
              <AgentElapsed agent={member} />
            </span>
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            provider={provider}
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
  provider,
  driver,
  onOpenThread,
}: {
  readonly group: AgentPanelWorkflowGroup;
  readonly header: ReactNode;
  readonly provider: ServerProvider | undefined;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openPhases, setOpenPhases] = useState<ReadonlySet<number>>(() => new Set());
  const label = group.workflow.workflowName ?? group.workflow.title;
  const phases = group.phases.filter((phase) => phase.members.length > 0);
  const allOpen = phases.length > 0 && phases.every((phase) => openPhases.has(phase.index));
  return (
    // The flag lets the lineage list trade its compact height for the open tree.
    <li className="group" data-workflow-expanded={expanded ? "" : undefined}>
      <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
        {header}
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={() => setExpanded((value) => !value)}
          className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </Button>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 ps-5">
          {phases.length > 1 ? (
            <li>
              <button
                type="button"
                onClick={() =>
                  setOpenPhases(allOpen ? new Set() : new Set(phases.map((phase) => phase.index)))
                }
                className={PHASE_CONTROL_CLASS}
              >
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            </li>
          ) : null}
          {phases.map((phase) => (
            <li key={phase.index}>
              <button
                type="button"
                aria-expanded={openPhases.has(phase.index)}
                onClick={() =>
                  setOpenPhases((open) => {
                    const next = new Set(open);
                    if (!next.delete(phase.index)) next.add(phase.index);
                    return next;
                  })
                }
                className={cn(
                  PHASE_CONTROL_CLASS,
                  "justify-start gap-2 font-semibold uppercase tracking-[0.08em]",
                  phase.state === "running" && "text-info",
                )}
              >
                <span className="min-w-0 truncate">{phase.title}</span>
                <span className="ms-auto shrink-0 tabular-nums">
                  {phase.settledCount}/{phase.members.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    !openPhases.has(phase.index) && "-rotate-90",
                  )}
                />
              </button>
              {openPhases.has(phase.index) ? (
                <ul className="m-0 list-none p-0">
                  {phase.members.map((member) => (
                    <WorkflowMemberRow
                      key={member.id}
                      member={member}
                      provider={provider}
                      driver={driver}
                      onOpen={onOpenThread}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
          {group.unphasedMembers.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              member={member}
              provider={provider}
              driver={driver}
              onOpen={onOpenThread}
            />
          ))}
          {phases.length === 0 && group.unphasedMembers.length === 0 ? (
            <li className="px-2.5 py-1.5 text-[11px] text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function ThreadLineageWorkflowCount({ group }: { group: AgentPanelWorkflowGroup }) {
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settled = members.filter((member) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(member.status),
  ).length;
  return (
    <>
      {settled}/{members.length}
      <span className="sr-only"> agents settled</span>
    </>
  );
}
