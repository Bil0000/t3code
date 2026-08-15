import { describe, expect, it } from "vite-plus/test";
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

import {
  getCustomModelCapabilityTemplates,
  getConfiguredCustomModelOptionDescriptors,
  makeSelectCustomModelCapabilityDescriptor,
  replaceCustomModelCapabilityDescriptor,
} from "./ProviderModelsSection";
describe("custom model capability configuration", () => {
  it("merges provider-supported controls and configured custom values", () => {
    const configured: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "ultra", label: "Ultra", isDefault: true }],
        },
      ],
    };
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "built-in",
        name: "Built In",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
            {
              id: "fastMode",
              label: "Fast Mode",
              type: "boolean",
            },
            {
              id: "toolMode",
              label: "Tool Mode",
              type: "boolean",
            },
          ],
        },
      },
    ];

    expect(getCustomModelCapabilityTemplates(models, configured)).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultra", label: "Ultra", isDefault: true },
        ],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ]);
  });

  it("builds declared supported values with one explicit default", () => {
    const template = {
      id: "effort",
      label: "Reasoning",
      description: "Controls reasoning effort.",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultra", label: "Ultra" },
      ],
    };

    expect(makeSelectCustomModelCapabilityDescriptor(template, ["low", "ultra"], "ultra")).toEqual({
      id: "effort",
      label: "Reasoning",
      description: "Controls reasoning effort.",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "ultra", label: "Ultra", isDefault: true },
      ],
      currentValue: "ultra",
    });
  });
  it("keeps context values within the provider-supported options", () => {
    const template = {
      id: "contextWindow",
      label: "Context Window",
      type: "select" as const,
      options: [
        { id: "200k", label: "200K", isDefault: true },
        { id: "1m", label: "1M" },
      ],
    };

    expect(
      makeSelectCustomModelCapabilityDescriptor(
        template,
        ["200k", "unsupported", "1m"],
        "unsupported",
      ),
    ).toEqual({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200K", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "200k",
    });
    expect(makeSelectCustomModelCapabilityDescriptor(template, ["unsupported"], undefined)).toBe(
      undefined,
    );
  });

  it("preserves an explicit empty capability set when the last control is disabled", () => {
    expect(
      replaceCustomModelCapabilityDescriptor(
        [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
        undefined,
        "fastMode",
      ),
    ).toEqual({ optionDescriptors: [] });
  });

  it("uses legacy fallback controls only when explicit metadata is absent", () => {
    const inherited: ModelCapabilities = {
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    };

    expect(getConfiguredCustomModelOptionDescriptors(undefined, inherited)).toEqual(
      inherited.optionDescriptors,
    );
    expect(getConfiguredCustomModelOptionDescriptors({}, inherited)).toEqual([]);
    expect(getConfiguredCustomModelOptionDescriptors({ optionDescriptors: [] }, inherited)).toEqual(
      [],
    );
  });
});
