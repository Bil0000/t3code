import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isActiveSubagentStatus,
  workflowPhaseElapsed,
  workflowPhaseStatus,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { subagentCardDetail } from "./subagent-card-presentation";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { resolveSubagentRowPresentation, workflowGroupSummary } from "./threadAgentsPresentation";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export function ThreadWorkflowGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly group: SubagentWorkflowGroup;
  readonly header: ReactNode;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { group } = props;
  const [expanded, setExpanded] = useState(() => isActiveSubagentStatus(group.workflow.status));
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const label = group.workflow.workflowName ?? group.workflow.title;
  const summary = workflowGroupSummary(group);
  const phases = group.phases.filter((phase) => phase.members.length > 0);

  return (
    <View className="border-b border-border pb-2">
      {props.header}
      <View className="-mt-2 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}, ${summary}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-3 rounded-lg active:opacity-70"
        >
          <View className="w-2 items-center">
            <SymbolView
              name={expanded ? "chevron.down" : "chevron.right"}
              size={11}
              tintColorClassName="accent-icon-subtle"
            />
          </View>
          <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
            {summary}
          </Text>
        </Pressable>
      </View>
      {expanded ? (
        <View className="ml-[3px] border-l border-border pl-3.5">
          {phases.map((phase) => {
            const open = phaseOpen.get(phase.index) ?? phase.state === "running";
            const status = workflowPhaseStatus(phase);
            const count = `${phase.settledCount}/${phase.members.length} ${phase.members.length === 1 ? "agent" : "agents"}`;
            return (
              <View key={phase.index}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${phase.title} phase, ${status}, ${count} done`}
                  accessibilityState={{ expanded: open }}
                  onPress={() =>
                    setPhaseOpen((current) => new Map(current).set(phase.index, !open))
                  }
                  className="min-h-11 flex-row items-center gap-2 active:opacity-70"
                >
                  <SymbolView
                    name={open ? "chevron.down" : "chevron.right"}
                    size={10}
                    tintColorClassName="accent-icon-subtle"
                  />
                  <Text
                    numberOfLines={1}
                    className={cn(
                      "min-w-0 shrink font-t3-medium text-xs",
                      phase.state === "running" ? "text-foreground" : "text-foreground-muted",
                    )}
                  >
                    {phase.title}
                  </Text>
                  {status === "failed" ? (
                    <Text
                      className={cn("text-2xs font-t3-medium", SUBAGENT_TONE_TEXT_CLASS.failed)}
                    >
                      Failed
                    </Text>
                  ) : null}
                  <View className="flex-1" />
                  <Text className="text-2xs tabular-nums text-foreground-muted">{count}</Text>
                  <WorkflowElapsed timing={workflowPhaseElapsed(phase)} />
                </Pressable>
                {open
                  ? phase.members.map((member) => (
                      <WorkflowMemberRow
                        key={member.id}
                        environmentId={props.environmentId}
                        member={member}
                        onOpen={props.onOpen}
                      />
                    ))
                  : null}
              </View>
            );
          })}
          {group.unphasedMembers.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              environmentId={props.environmentId}
              member={member}
              onOpen={props.onOpen}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function WorkflowMemberRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: RuntimeSubagent;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { member } = props;
  const threadId = member.childThreadId === null ? null : ThreadId.make(member.childThreadId);
  const shell = useThreadShell(
    threadId === null ? null : scopeThreadRef(props.environmentId, threadId),
  );
  const canOpen = threadId !== null && shell !== null;
  const presentation = resolveSubagentRowPresentation({
    title: member.title,
    prompt: "",
    status: member.status,
    progress: member.progress ?? undefined,
    result: member.result ?? member.error,
    childThreadId: threadId,
  });
  const detail = subagentCardDetail(presentation.detail);
  return (
    <Pressable
      accessibilityRole={canOpen ? "link" : undefined}
      accessibilityLabel={`${presentation.title}, ${presentation.statusLabel}`}
      accessibilityHint={canOpen ? "Opens this agent's thread" : "Its thread is not available yet"}
      disabled={!canOpen}
      onPress={() => threadId !== null && props.onOpen(threadId)}
      className="min-h-11 flex-row gap-2.5 py-2 active:opacity-70"
    >
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-h-5 flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {presentation.title}
          </Text>
          <Text className={cn("shrink-0 text-xs", SUBAGENT_TONE_TEXT_CLASS[presentation.tone])}>
            {presentation.statusLabel}
          </Text>
          <WorkflowElapsed timing={member} />
          {canOpen ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
        </View>
        {detail ? (
          <Text numberOfLines={2} className="text-xs text-foreground-muted">
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function WorkflowElapsed({
  timing,
}: {
  readonly timing: Parameters<typeof deriveSubagentElapsedMs>[0];
}) {
  const nowMs = useVisibleSecondClock(isActiveSubagentStatus(timing.status));
  const elapsedMs = deriveSubagentElapsedMs(timing, nowMs);
  return elapsedMs === null || elapsedMs === 0 ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
      {formatDuration(elapsedMs)}
    </Text>
  );
}
