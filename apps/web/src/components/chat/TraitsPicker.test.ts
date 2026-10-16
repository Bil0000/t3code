import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  buildUnavailableModelOptionDescriptors,
  getReasoningLevelChange,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

describe("reasoning level shortcuts", () => {
  const options = [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "ultrathink", label: "Ultrathink" },
  ];
  const modelWith = (
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  ): ServerProviderModel[] => [
    {
      slug: "test-model",
      name: "Test",
      isCustom: false,
      capabilities: { optionDescriptors: descriptors },
    },
  ];
  const input = {
    provider: CODEX,
    model: "test-model",
    models: modelWith([
      { ...selectDescriptor("effort", options, "high"), promptInjectedValues: ["ultrathink"] },
      fastModeDescriptor(false),
    ]),
    modelOptions: [{ id: "fastMode", value: true }],
    prompt: "Solve this",
    planModeEnabled: false,
    direction: -1 as const,
  };

  it("steps from the default and keeps other traits", () => {
    expect(getReasoningLevelChange(input)).toEqual({
      prompt: "Solve this",
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
    expect(
      getReasoningLevelChange({
        ...input,
        models: modelWith([{ id: "effort", label: "Effort", type: "select", options }]),
      })?.modelOptions,
    ).toEqual([{ id: "effort", value: "low" }]);
  });

  it("steps from the displayed reported value unless the draft overrides it", () => {
    const instanceId = ProviderInstanceId.make("custom-codex");
    const reportedModelSelection = {
      instanceId,
      model: "test-model",
      options: [{ id: "effort", value: "low" }],
    };
    const reportedInput = { ...input, instanceId, reportedModelSelection, direction: 1 as const };
    expect(getReasoningLevelChange(reportedInput)?.modelOptions).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    expect(
      getReasoningLevelChange({
        ...reportedInput,
        modelOptions: [{ id: "effort", value: "high" }],
      }),
    ).toEqual({ prompt: "Ultrathink:\nSolve this", promptSelectionOffset: 12 });
    expect(
      getReasoningLevelChange({
        ...reportedInput,
        reportedModelSelection: {
          ...reportedModelSelection,
          instanceId: ProviderInstanceId.make("another-codex"),
        },
      }),
    ).toEqual({ prompt: "Ultrathink:\nSolve this", promptSelectionOffset: 12 });
    expect(
      getReasoningLevelChange({
        ...reportedInput,
        reportedModelSelection: { ...reportedModelSelection, model: "another-model" },
      }),
    ).toEqual({ prompt: "Ultrathink:\nSolve this", promptSelectionOffset: 12 });
  });

  it("uses a catalog default for an unset OpenCode variant", () => {
    expect(
      getReasoningLevelChange({
        ...input,
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode"),
        models: modelWith([selectDescriptor("variant", options, "high")]),
      })?.modelOptions,
    ).toEqual([{ id: "variant", value: "low" }]);
  });

  it("wraps at both ends, including prompt-controlled ultrathink", () => {
    expect(
      getReasoningLevelChange({ ...input, modelOptions: [{ id: "effort", value: "low" }] }),
    ).toEqual({ prompt: "Ultrathink:\nSolve this", promptSelectionOffset: 12 });
    expect(
      getReasoningLevelChange({ ...input, prompt: "Ultrathink:\nSolve this", direction: 1 }),
    ).toEqual({
      prompt: "Solve this",
      promptSelectionOffset: -12,
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("enters and leaves prompt-controlled ultrathink", () => {
    expect(getReasoningLevelChange({ ...input, direction: 1 })).toEqual({
      prompt: "Ultrathink:\nSolve this",
      promptSelectionOffset: 12,
    });
    expect(getReasoningLevelChange({ ...input, prompt: "Ultrathink:\nSolve this" })).toEqual({
      prompt: "Solve this",
      promptSelectionOffset: -12,
      modelOptions: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
    expect(
      getReasoningLevelChange({ ...input, prompt: "Please ultrathink about this" }),
    ).toBeNull();
  });

  it("preserves slash commands and can add the prefix to an empty prompt", () => {
    expect(getReasoningLevelChange({ ...input, prompt: "/review", direction: 1 })).toEqual({
      prompt: "/review",
    });
    expect(getReasoningLevelChange({ ...input, prompt: "", direction: 1 })).toEqual({
      prompt: "Ultrathink:\n",
      promptSelectionOffset: 12,
    });
  });

  it.each([
    { prompt: "Alpha beta gamma   ", direction: 1 as const },
    { prompt: "  Alpha beta gamma   ", direction: 1 as const },
    { prompt: "Ultrathink:\nAlpha beta gamma   ", direction: -1 as const },
    { prompt: "Ultrathink:\n  Alpha beta gamma   ", direction: 1 as const },
  ])("keeps both selection endpoints in retained text for $prompt", ({ prompt, direction }) => {
    const change = getReasoningLevelChange({ ...input, prompt, direction });
    if (!change || !("promptSelectionOffset" in change)) {
      throw new Error("Expected an effort prompt change");
    }
    const offset = change.promptSelectionOffset;
    const start = prompt.indexOf("beta") + offset;
    const end = start + "beta".length;
    expect(change.prompt.slice(start, end)).toBe("beta");
    expect(change.prompt.slice(0, start) + "X" + change.prompt.slice(end)).toBe(
      change.prompt.replace("beta", "X"),
    );
  });

  it.each([
    ["codex", "reasoningEffort"],
    ["claudeAgent", "effort"],
    ["cursor", "reasoning"],
    ["grok", "reasoningEffort"],
    ["opencode", "variant"],
    ["antigravity", "thinking"],
  ])("uses %s model choices in catalog order", (provider, id) => {
    for (const [current, direction, expected] of [
      ["high", -1, "low"],
      ["low", -1, "ultrathink"],
      ["ultrathink", 1, "low"],
    ] as const) {
      expect(
        getReasoningLevelChange({
          ...input,
          provider: ProviderDriverKind.make(provider),
          models: modelWith([CONTEXT_WINDOW, selectDescriptor(id, options, current)]),
          direction,
        })?.modelOptions,
      ).toEqual([
        { id: "contextWindow", value: "1m" },
        { id, value: expected },
      ]);
    }
  });

  it.each([1, -1] as const)(
    "leaves a single effort choice unchanged in direction %s",
    (direction) => {
      expect(
        getReasoningLevelChange({
          ...input,
          models: modelWith([selectDescriptor("effort", options.slice(0, 1), "low")]),
          direction,
        }),
      ).toBeNull();
    },
  );

  it.each(["agent", "contextWindow"])("does not change %s options", (id) => {
    expect(
      getReasoningLevelChange({
        ...input,
        models: modelWith([selectDescriptor(id, options, "high")]),
      }),
    ).toBeNull();
  });

  it("does nothing without an available effort choice", () => {
    expect(getReasoningLevelChange({ ...input, models: [] })).toBeNull();
    expect(getReasoningLevelChange({ ...input, models: modelWith([]) })).toBeNull();
    expect(
      getReasoningLevelChange({
        ...input,
        models: modelWith([selectDescriptor("effort", [], "low")]),
      }),
    ).toBeNull();
    expect(
      getReasoningLevelChange({
        ...input,
        models: modelWith([selectDescriptor("effort", options, "stale")]),
      }),
    ).toBeNull();
    expect(
      getReasoningLevelChange({
        ...input,
        provider: ProviderDriverKind.make("opencode"),
        models: [],
        modelOptions: [{ id: "variant", value: "high" }],
      }),
    ).toBeNull();
  });
});

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
    });
  });

  it("pairs fast mode with reasoning before the context window", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High Fast · 1M",
    });
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({
      label: "High Fast · 1M",
    });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking"])(
    "pairs Fast with %s even when context is the primary select",
    (id) => {
      for (const speed of [fastModeDescriptor(true), serviceTierDescriptor("priority")]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: CODEX,
            descriptors: [
              selectDescriptor("profile", [{ id: "balanced", label: "Balanced" }], "balanced"),
              CONTEXT_WINDOW,
              { ...EFFORT, id },
              speed,
            ],
            primarySelectDescriptorId: "profile",
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: "Balanced · 1M · High Fast" });
      }
      expect(
        buildTraitsTriggerDisplay({
          provider: CODEX,
          descriptors: [CONTEXT_WINDOW, { ...EFFORT, id }, serviceTierDescriptor("ultrafast")],
          primarySelectDescriptorId: CONTEXT_WINDOW.id,
          ultrathinkPromptControlled: false,
        }),
      ).toEqual({ label: "1M · High Ultrafast" });
    },
  );

  it("pairs Cursor Fast with reasoning rather than the thinking toggle", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("cursor"),
        descriptors: [
          { ...EFFORT, id: "reasoning" },
          fastModeDescriptor(true),
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
        primarySelectDescriptorId: "reasoning",
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label: "High Fast · Thinking On" });
  });

  it.each([true, false])("keeps boolean thinking %s independent of Fast", (currentValue) => {
    const thinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue,
    };
    const label = `Thinking ${currentValue ? "On" : "Off"}`;
    expect(display([thinking, fastModeDescriptor(true)])).toEqual({ label: `${label} · Fast` });
    expect(display([thinking, { ...EFFORT, id: "reasoning" }, fastModeDescriptor(true)])).toEqual({
      label: `${label} · High Fast`,
    });
    expect(display([thinking, fastModeDescriptor(false)])).toEqual({ label });
  });

  it("keeps speed separate when there is no reasoning descriptor", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({ label: "1M · Fast" });
  });

  it.each(["Low", "Medium", "High", "Extra High", "Max", "Ultra"])(
    "preserves %s reasoning with Fast across harnesses",
    (label) => {
      for (const provider of ["codex", "claudeAgent", "cursor"]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: ProviderDriverKind.make(provider),
            descriptors: [
              { ...EFFORT, options: [{ id: "effort", label }], currentValue: "effort" },
              fastModeDescriptor(true),
            ],
            primarySelectDescriptorId: EFFORT.id,
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: `${label} Fast` });
      }
    },
  );

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({ label: "High" });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({ label: "High Fast" });
  });

  it("keeps Codex Ultrafast distinct from Fast", () => {
    expect(display([EFFORT, serviceTierDescriptor("ultrafast")])).toEqual({
      label: "High Ultrafast",
    });
  });

  it("uses Ultrafast without requiring a Fast tier", () => {
    const descriptor = serviceTierDescriptor("ultrafast");
    expect(
      display([
        EFFORT,
        { ...descriptor, options: descriptor.options.filter(({ id }) => id !== "priority") },
      ]),
    ).toEqual({ label: "High Ultrafast" });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({ label: "High · Flex" });
  });

  it("keeps Standard as text for models without speed tiers", () => {
    const descriptor = serviceTierDescriptor("default");
    const nonSpeedDescriptor = {
      ...descriptor,
      options: descriptor.options.filter(({ id }) => id === "default" || id === "flex"),
    };
    expect(display([EFFORT, nonSpeedDescriptor])).toEqual({ label: "High · Standard" });
    expect(display([nonSpeedDescriptor])).toEqual({ label: "Standard" });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({ label: "Standard" });
    expect(display([serviceTierDescriptor("priority")])).toEqual({ label: "Fast" });
  });

  it("keeps Ultrafast readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("ultrafast")])).toEqual({ label: "Ultrafast" });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({ label: "High · Thinking On" });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({ label: "Fast" });
    expect(display([fastModeDescriptor(false)])).toEqual({ label: "Normal" });
  });

  it("does not add Fast to a model without a speed option", () => {
    expect(display([EFFORT, CONTEXT_WINDOW])).toEqual({ label: "High · 1M" });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "" });
  });

  it("still renders prompt-controlled ultrathink with Fast", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink Fast" });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});

it("shows Unknown until a matching provider report provides Default", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "ling",
    options: [],
  };
  const input = {
    provider: ProviderDriverKind.make("opencode"),
    descriptors: [
      selectDescriptor(
        "variant",
        [
          { id: "none", label: "None" },
          { id: "thinking", label: "Thinking" },
        ],
        "",
      ),
    ],
    primarySelectDescriptorId: "variant",
    ultrathinkPromptControlled: false,
    modelSelection: selection,
  };
  expect(buildTraitsTriggerDisplay(input).label).toBe("Unknown");
  expect(
    buildTraitsTriggerDisplay({
      ...input,
      reportedModelSelection: { ...selection, options: [{ id: "variant", value: "default" }] },
    }).label,
  ).toBe("Default");
});
