import { describe, expect, it } from "vite-plus/test";
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  reconcileCustomModelCapabilities,
  updateCustomModelCapabilitiesRecord,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["server-model", "kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("uses current config capabilities while the live custom row is stale", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
      ],
    };
    const input = {
      liveModels: [
        {
          slug: "gateway/model",
          name: "gateway/model",
          isCustom: true,
          capabilities: null,
        },
      ],
      customModels: ["gateway/model"],
      customModelCapabilities: { "gateway/model": capabilities },
    } satisfies Parameters<typeof deriveProviderModelsForDisplay>[0] & {
      readonly customModelCapabilities: Readonly<Record<string, ModelCapabilities>>;
    };

    expect(deriveProviderModelsForDisplay(input)[0]?.capabilities).toEqual(capabilities);
  });

  it("keeps legacy metadata absent and seeds newly added models with no controls", () => {
    const configured: ModelCapabilities = {
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    };

    expect(
      reconcileCustomModelCapabilities({
        capabilities: { configured, removed: { optionDescriptors: [] } },
        currentModels: ["legacy", "configured", "removed"],
        nextModels: ["legacy", "configured", "new"],
      }),
    ).toEqual({
      configured,
      new: { optionDescriptors: [] },
    });
  });

  it("stores prototype-shaped model IDs as own capability keys", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    };

    const updated = updateCustomModelCapabilitiesRecord({}, "__proto__", capabilities);
    expect(Object.hasOwn(updated, "__proto__")).toBe(true);
    expect(updated["__proto__"]).toEqual(capabilities);

    const removed = updateCustomModelCapabilitiesRecord(updated, "__proto__", undefined);
    expect(Object.hasOwn(removed, "__proto__")).toBe(false);

    const reconciled = reconcileCustomModelCapabilities({
      capabilities: {},
      currentModels: [],
      nextModels: ["constructor"],
    });
    expect(Object.hasOwn(reconciled, "constructor")).toBe(true);
    expect(reconciled["constructor"]).toEqual({ optionDescriptors: [] });
  });
});
