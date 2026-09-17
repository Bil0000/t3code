import { createModelSelection } from "@t3tools/shared/model";
import type { ModelSelection, ProviderInstanceId, VcsRef } from "@t3tools/contracts";

export function resolveScheduledTaskBaseRef(
  baseRef: string,
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault">>,
): string {
  return baseRef.trim() || refs.find((ref) => ref.isDefault)?.name || "";
}

export function resolveScheduledTaskModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  current: ModelSelection | null,
  saved: ModelSelection | null | undefined,
): ModelSelection {
  return (
    [current, saved].find(
      (selection) => selection?.instanceId === instanceId && selection.model === model,
    ) ?? createModelSelection(instanceId, model)
  );
}
