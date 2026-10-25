import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSubagentTraits, workflowMemberRowSubagent } from "./threadAgentsPresentation";

const instanceId = ProviderInstanceId.make("codex");
const selection: ModelSelection = {
  instanceId,
  model: "gpt-test",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ],
};
const subagent = {
  providerInstanceId: instanceId,
  model: "GPT Test",
  origin: "app_owned" as const,
  modelSelection: selection,
};
const provider = {
  driver: ProviderDriverKind.make("codex"),
  models: [
    {
      slug: "gpt-test",
      name: "GPT Test",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "high", label: "High" }],
          },
          {
            id: "serviceTier",
            label: "Speed",
            type: "select" as const,
            options: [
              { id: "default", label: "Normal" },
              { id: "priority", label: "Fast" },
              { id: "ultra", label: "Ultrafast" },
            ],
            currentValue: "priority",
          },
        ],
      },
    },
  ],
};

describe("subagent traits", () => {
  it.each([null, "derived-native-child"])(
    "does not borrow settings for a workflow member with child %s",
    (childThreadId) => {
      const row = workflowMemberRowSubagent(
        {
          childThreadId,
          model: "GPT Test",
          title: "Worker",
          progress: null,
          status: "running",
          result: null,
          error: null,
        },
        { driver: provider.driver, providerInstanceId: instanceId },
        ThreadId.make("coordinator"),
      );
      expect(
        resolveSubagentTraits({
          subagent: row,
          provider,
          childThread: { providerInstanceId: instanceId, modelSelection: selection },
        }).traits,
      ).toBe("");
    },
  );

  it("does not match two models that are absent from the catalog", () => {
    expect(
      resolveSubagentTraits({
        subagent: {
          ...subagent,
          model: "missing-agent-model",
          modelSelection: { ...selection, model: "missing-selection-model" },
        },
        provider,
      }).traits,
    ).toBe("");
  });

  it("hides an obsolete saved effort value", () => {
    expect(
      resolveSubagentTraits({
        subagent: {
          ...subagent,
          modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "removed" }] },
        },
        provider,
      }).traits,
    ).toBe("");
  });
  it("shows the agent's saved effort and speed, including model display names", () => {
    expect(resolveSubagentTraits({ subagent, provider }).traits).toBe("High · Fast");
  });

  it("uses an app-owned child's selection when the agent has no saved selection", () => {
    expect(
      resolveSubagentTraits({
        subagent: { ...subagent, modelSelection: undefined },
        provider,
        childThread: { providerInstanceId: instanceId, modelSelection: selection },
      }).traits,
    ).toBe("High · Fast");
  });

  it("does not use a provider-managed child's selection", () => {
    expect(
      resolveSubagentTraits({
        subagent: { ...subagent, origin: "provider_native", modelSelection: undefined },
        provider,
        childThread: { providerInstanceId: instanceId, modelSelection: selection },
      }).traits,
    ).toBe("");
  });

  it.each([
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, model: "other" },
  ])("hides settings from a different model or provider instance", (modelSelection) => {
    expect(
      resolveSubagentTraits({ subagent: { ...subagent, modelSelection }, provider }).traits,
    ).toBe("");
  });

  it("does not fill missing settings from catalog defaults", () => {
    expect(
      resolveSubagentTraits({
        subagent: { ...subagent, modelSelection: { ...selection, options: [] } },
        provider,
      }).traits,
    ).toBe("");
  });

  it("keeps the saved selection ahead of later child settings", () => {
    expect(
      resolveSubagentTraits({
        subagent,
        provider,
        childThread: {
          providerInstanceId: instanceId,
          modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "low" }] },
        },
      }).traits,
    ).toBe("High · Fast");
  });

  it("shows Claude effort and boolean fast mode", () => {
    expect(
      resolveSubagentTraits({
        subagent: {
          ...subagent,
          modelSelection: {
            ...selection,
            options: [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          },
        },
        provider: {
          ...provider,
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              ...provider.models[0]!,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "max", label: "Max" }],
                  },
                  { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
                ],
              },
            },
          ],
        },
      }).traits,
    ).toBe("Max · Fast");
  });

  it.each([
    ["ultra", "Ultrafast"],
    ["default", "Normal"],
    ["removed", ""],
  ])("shows only known saved speed values: %s", (value, label) => {
    expect(
      resolveSubagentTraits({
        subagent: {
          ...subagent,
          modelSelection: { ...selection, options: [{ id: "serviceTier", value }] },
        },
        provider,
      }).traits,
    ).toBe(label);
  });

  it("uses a validated app-owned child's provider for cross-provider workflow traits", () => {
    const childInstanceId = ProviderInstanceId.make("claude");
    const childSelection: ModelSelection = {
      instanceId: childInstanceId,
      model: "claude-test",
      options: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
    };
    const childProvider = {
      instanceId: childInstanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-test",
          name: "Claude Test",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "max", label: "Max" }],
              },
              { id: "fastMode", label: "Fast", type: "boolean" as const },
            ],
          },
        },
      ],
    };
    const input = {
      subagent: { ...subagent, model: "Claude Test", modelSelection: undefined },
      provider,
      childProvider,
      childThread: { providerInstanceId: childInstanceId, modelSelection: childSelection },
    };
    expect(resolveSubagentTraits(input)).toEqual({
      traits: "Max · Fast",
      providerInstanceId: childInstanceId,
    });
    expect(resolveSubagentTraits({ ...input, subagent })).toEqual({
      traits: "High · Fast",
      providerInstanceId: instanceId,
    });
    expect(
      resolveSubagentTraits({
        ...input,
        subagent: { ...input.subagent, origin: "provider_native" },
      }).traits,
    ).toBe("");
    expect(resolveSubagentTraits({ ...input, childThread: undefined }).traits).toBe("");
    expect(resolveSubagentTraits({ ...input, childProvider: undefined }).traits).toBe("");
    expect(
      resolveSubagentTraits({
        ...input,
        childThread: { ...input.childThread, providerInstanceId: instanceId },
      }).traits,
    ).toBe("");
    expect(
      resolveSubagentTraits({ ...input, childProvider: { ...childProvider, instanceId } }).traits,
    ).toBe("");
    expect(
      resolveSubagentTraits({ ...input, subagent: { ...input.subagent, model: "another-model" } }),
    ).toEqual({ traits: "", providerInstanceId: instanceId });
    expect(
      resolveSubagentTraits({
        subagent: { ...subagent, modelSelection: undefined },
        provider,
        childThread: { providerInstanceId: childInstanceId, modelSelection: selection },
      }).traits,
    ).toBe("");
  });
});
