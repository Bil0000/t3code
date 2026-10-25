import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";
import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue, resolveSelectableModel } from "@t3tools/shared/model";

const PROMPT_TITLE_LIMIT = 80;

export function resolveSubagentTraits(input: {
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    "model" | "providerInstanceId" | "origin" | "modelSelection"
  >;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | undefined;
  readonly childThread?: Pick<OrchestrationV2ThreadShell, "modelSelection"> | undefined;
}): string {
  const { subagent, provider } = input;
  const selection =
    subagent.modelSelection ??
    (subagent.origin === "app_owned" ? input.childThread?.modelSelection : undefined);
  const modelSlug = provider
    ? resolveSelectableModel(provider.driver, subagent.model, provider.models)
    : subagent.model?.trim();
  const selectedModel = provider
    ? resolveSelectableModel(provider.driver, selection?.model, provider.models)
    : selection?.model.trim();
  if (
    !selection ||
    selectedModel !== modelSlug ||
    selection.instanceId !== subagent.providerInstanceId
  )
    return "";

  const effort = REASONING_EFFORT_OPTION_IDS.map((id) =>
    getModelSelectionStringOptionValue(selection, id),
  ).find(Boolean);
  const descriptors =
    provider?.models.find((model) => model.slug === modelSlug)?.capabilities?.optionDescriptors ??
    [];
  const speed = descriptors
    .map((descriptor) => {
      const saved = selection.options?.find((option) => option.id === descriptor.id);
      if (
        descriptor.id === "fastMode" &&
        descriptor.type === "boolean" &&
        typeof saved?.value === "boolean"
      ) {
        return { ...descriptor, currentValue: saved.value };
      }
      if (
        provider?.driver === "codex" &&
        descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        typeof saved?.value === "string" &&
        descriptor.options.some((option) => option.id === saved.value)
      ) {
        return { ...descriptor, currentValue: saved.value };
      }
      return null;
    })
    .find((descriptor) => descriptor !== null);
  const speedLabel =
    provider && speed
      ? buildTraitsTriggerDisplay({
          provider: provider.driver,
          descriptors: [speed],
          primarySelectDescriptorId: null,
          ultrathinkPromptControlled: false,
        }).label
      : null;
  return [effort, speedLabel].filter(Boolean).join(" · ");
}

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}
