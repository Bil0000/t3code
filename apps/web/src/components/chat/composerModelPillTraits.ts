import type { ProviderDriverKind, ProviderOptionDescriptor } from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";

export type SelectTraitDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

const NON_EFFORT_SELECT_IDS = new Set(["contextWindow", "serviceTier", "agent"]);

export interface FastModeState {
  descriptorId: string;
  enabled: boolean;
  /** Value to write on the descriptor to flip fast mode. */
  toggledValue: string | boolean;
}

/**
 * Fast mode is either a `fastMode` boolean descriptor or, for Codex, the
 * Standard/Fast pair of the `serviceTier` select.
 */
export function resolveFastMode(
  provider: ProviderDriverKind,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): FastModeState | null {
  for (const descriptor of descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      const enabled = descriptor.currentValue === true;
      return { descriptorId: descriptor.id, enabled, toggledValue: !enabled };
    }
    if (provider === "codex" && descriptor.id === "serviceTier" && descriptor.type === "select") {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      if (fastTier && (currentValue === "default" || currentValue === fastTier.id)) {
        const enabled = currentValue === fastTier.id;
        return {
          descriptorId: descriptor.id,
          enabled,
          toggledValue: enabled ? "default" : fastTier.id,
        };
      }
    }
  }
  return null;
}

/** The select that drives the effort slider: the first non-structural select. */
export function resolveEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): SelectTraitDescriptor | null {
  return (
    descriptors.find(
      (descriptor): descriptor is SelectTraitDescriptor =>
        descriptor.type === "select" && !NON_EFFORT_SELECT_IDS.has(descriptor.id),
    ) ?? null
  );
}

/** 0 at the lowest level, 1 at the highest. */
export function effortFraction(index: number, count: number): number {
  return count <= 1 ? 1 : Math.min(1, Math.max(0, index / (count - 1)));
}

export function nextSelectOptionId(descriptor: SelectTraitDescriptor): string | null {
  if (descriptor.options.length === 0) return null;
  const current = getProviderOptionCurrentValue(descriptor);
  const index = descriptor.options.findIndex((option) => option.id === current);
  return descriptor.options[(index + 1) % descriptor.options.length]!.id;
}
