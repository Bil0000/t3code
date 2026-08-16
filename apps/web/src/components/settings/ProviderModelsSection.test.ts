import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CustomModelCapabilitiesEditor,
  ProviderModelsSection,
  createCustomModelCapabilityDescriptor,
  getConfiguredCustomModelOptionDescriptors,
  makeSelectCustomModelCapabilityDescriptor,
  replaceCustomModelCapabilityDescriptor,
} from "./ProviderModelsSection";
describe("custom model capability configuration", () => {
  it("creates free-form select and boolean descriptors without provider templates", () => {
    const select = createCustomModelCapabilityDescriptor([], "select");
    const boolean = createCustomModelCapabilityDescriptor([select], "boolean");

    expect(select).toEqual({
      id: "option",
      label: "Option",
      type: "select",
      options: [{ id: "default", label: "Default", isDefault: true }],
      currentValue: "default",
    });
    expect(boolean).toEqual({
      id: "option2",
      label: "Option 2",
      type: "boolean",
      currentValue: false,
    });
  });

  it("offers free-form descriptor types when provider reports no templates", () => {
    const model: ServerProviderModel = {
      slug: "vendor/model",
      name: "vendor/model",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    };
    const markup = renderToStaticMarkup(
      createElement(CustomModelCapabilitiesEditor, {
        model,
        value: { optionDescriptors: [] },
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Add select control for vendor/model"');
    expect(markup).toContain('aria-label="Add boolean control for vendor/model"');
    expect(markup).not.toContain("Provider has not reported configurable model controls");
  });

  it("shows model details for arbitrary descriptors", () => {
    const model: ServerProviderModel = {
      slug: "vendor/model",
      name: "vendor/model",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "temperature",
            label: "Temperature",
            type: "select",
            options: [{ id: "balanced", label: "Balanced" }],
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        instanceId: ProviderInstanceId.make("test-provider"),
        driverKind: null,
        models: [model],
        customModels: [model.slug],
        customModelCapabilities: {},
        onCustomModelCapabilitiesChange: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onChange: () => undefined,
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Details for vendor/model"');
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

  it("uses the declared default when currentValue is absent", () => {
    const template = {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
    };

    expect(makeSelectCustomModelCapabilityDescriptor(template, ["low", "high"], undefined)).toEqual(
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "high",
      },
    );
  });

  it("accepts arbitrary values for every select descriptor", () => {
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
        { id: "200k", label: "200K" },
        { id: "unsupported", label: "Unsupported", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "unsupported",
    });
    expect(makeSelectCustomModelCapabilityDescriptor(template, ["unsupported"], undefined)).toEqual(
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [{ id: "unsupported", label: "Unsupported", isDefault: true }],
        currentValue: "unsupported",
      },
    );
    expect(makeSelectCustomModelCapabilityDescriptor(template, [], undefined)).toBeUndefined();
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
