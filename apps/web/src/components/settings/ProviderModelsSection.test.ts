import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelCapabilities,
  type SelectProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CustomModelCapabilitiesEditor,
  ProviderModelsSection,
  addSelectCustomModelCapabilityValue,
  applySelectCustomModelCapabilityUpdate,
  createCustomModelCapabilityDescriptor,
  getConfiguredCustomModelOptionDescriptors,
  isSelectCustomModelCapabilityValueCommitKey,
  makeSelectCustomModelCapabilityDescriptor,
  replaceCustomModelCapabilityDescriptor,
  setSelectCustomModelCapabilityDefault,
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
        onSave: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Add select control for vendor/model"');
    expect(markup).toContain('aria-label="Add boolean control for vendor/model"');
    expect(markup).not.toContain("Provider has not reported configurable model controls");
  });

  it("renders exact select values as tags so commas stay inside IDs", () => {
    const model: ServerProviderModel = {
      slug: "vendor/model",
      name: "vendor/model",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    };
    const markup = renderToStaticMarkup(
      createElement(CustomModelCapabilitiesEditor, {
        model,
        value: {
          optionDescriptors: [
            {
              id: "quality",
              label: "Quality",
              type: "select",
              options: [{ id: "quality,high", label: "Quality high", isDefault: true }],
              currentValue: "quality,high",
            },
          ],
        },
        onChange: () => undefined,
        onSave: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Set quality,high as default for Quality"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("quality,high");
    expect(markup).toContain('placeholder="Add value…"');
    expect(markup).toContain("focus-within:ring-[3px]");
  });

  it("adds one trimmed select value without changing existing labels", () => {
    const descriptor = {
      id: "quality",
      label: "Quality",
      type: "select" as const,
      options: [{ id: "low", label: "Low quality", isDefault: true }],
      currentValue: "low",
    };

    expect(addSelectCustomModelCapabilityValue(descriptor, " quality,high ")).toEqual({
      ...descriptor,
      options: [
        { id: "low", label: "Low quality", isDefault: true },
        { id: "quality,high", label: "Quality,high" },
      ],
    });
    expect(addSelectCustomModelCapabilityValue(descriptor, " low ")).toBe(descriptor);
  });

  it("makes a clicked select value the only default", () => {
    const descriptor = {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "low", label: "Low", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "low",
    };

    expect(setSelectCustomModelCapabilityDefault(descriptor, "high")).toEqual({
      ...descriptor,
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    });
  });

  it("keeps a blurred value when the next tag action sets the default", () => {
    const descriptorRef: { current: SelectProviderOptionDescriptor } = {
      current: {
        id: "effort",
        label: "Reasoning",
        type: "select" as const,
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "low",
      },
    };
    let savedDescriptor: SelectProviderOptionDescriptor = descriptorRef.current;
    const saveDescriptor = (descriptor: SelectProviderOptionDescriptor) => {
      savedDescriptor = descriptor;
    };

    applySelectCustomModelCapabilityUpdate(
      descriptorRef,
      (descriptor) => addSelectCustomModelCapabilityValue(descriptor, "max"),
      saveDescriptor,
    );
    applySelectCustomModelCapabilityUpdate(
      descriptorRef,
      (descriptor) => setSelectCustomModelCapabilityDefault(descriptor, "high"),
      saveDescriptor,
    );

    expect(savedDescriptor.options).toEqual([
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
      { id: "max", label: "Max" },
    ]);
    expect(savedDescriptor.currentValue).toBe("high");
  });

  it("commits select values with space, comma, or Enter", () => {
    expect([" ", ",", "Enter"].map(isSelectCustomModelCapabilityValueCommitKey)).toEqual([
      true,
      true,
      true,
    ]);
    expect(isSelectCustomModelCapabilityValueCommitKey("Tab")).toBe(false);
  });

  it("shows a Save action and capitalized boolean heading", () => {
    const model: ServerProviderModel = {
      slug: "vendor/model",
      name: "vendor/model",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    };
    const markup = renderToStaticMarkup(
      createElement(CustomModelCapabilitiesEditor, {
        model,
        value: {
          optionDescriptors: [
            { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
          ],
        },
        onChange: () => undefined,
        onSave: () => undefined,
      }),
    );

    expect(markup).toContain("ON / OFF");
    expect(markup).toContain(">Save</button>");
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

  it("replaces a control without changing its position", () => {
    const effort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      options: [{ id: "high", label: "High", isDefault: true }],
    };
    const fastMode = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };

    expect(
      replaceCustomModelCapabilityDescriptor(
        [effort, fastMode],
        { ...effort, label: "Reasoning effort" },
        effort.id,
      ),
    ).toEqual({
      optionDescriptors: [{ ...effort, label: "Reasoning effort" }, fastMode],
    });
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
