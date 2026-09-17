import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
} from "@t3tools/shared/model";
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  VcsRef,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

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

export function resolveScheduledTaskBackupModel(
  selection: ModelSelection | null,
  source: ProviderInstanceEntry | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (!selection || !source) return null;
  const sourceModel = source.models.find((model) => model.slug === selection.model);
  const options = [
    ...new Map(
      [
        ...(buildProviderOptionSelectionsFromDescriptors(
          sourceModel?.capabilities?.optionDescriptors,
        ) ?? []),
        ...(selection.options ?? []),
      ].map((option) => [option.id, option]),
    ).values(),
  ];
  const compatible = providers.filter((provider) => {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.availability === "unavailable" ||
      provider.driver !== source.driverKind
    )
      return false;
    const model = provider.models.find((model) => model.slug === selection.model);
    return (
      model !== undefined &&
      options.every((option) => {
        const descriptor = model.capabilities?.optionDescriptors?.find(
          (entry) => entry.id === option.id,
        );
        return descriptor?.type === "boolean"
          ? typeof option.value === "boolean"
          : descriptor?.options.some((choice) => choice.id === option.value) === true;
      })
    );
  });
  const target =
    compatible.find((provider) => provider.instanceId === selection.instanceId) ??
    (source.driverKind !== "acpRegistry"
      ? (compatible.find((provider) => String(provider.instanceId) === source.driverKind) ??
        (compatible.length === 1 ? compatible[0] : undefined))
      : undefined);
  return target ? createModelSelection(target.instanceId, selection.model, options) : null;
}
