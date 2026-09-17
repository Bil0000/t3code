import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveScheduledTaskModelSelection,
  resolveScheduledTaskBaseRef,
  resolveScheduledTaskBackupModel,
} from "./ScheduledTasksSettings.logic";

describe("scheduled task base ref", () => {
  const refs = [
    { name: "feature/test", isDefault: false },
    { name: "develop", isDefault: true },
  ];

  it("uses the repository default instead of main or the current branch", () => {
    expect(resolveScheduledTaskBaseRef("", refs)).toBe("develop");
    expect(resolveScheduledTaskBaseRef("", [{ name: "origin/develop", isDefault: true }])).toBe(
      "origin/develop",
    );
  });

  it("keeps an explicit ref and does not guess while refs are unavailable", () => {
    expect(resolveScheduledTaskBaseRef(" release ", refs)).toBe("release");
    expect(resolveScheduledTaskBaseRef("", [])).toBe("");
    expect(resolveScheduledTaskBaseRef("", [{ name: "feature/test", isDefault: false }])).toBe("");
  });
});

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-17T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5",
      name: "GPT-5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            currentValue: "medium",
            options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};
const source = deriveProviderInstanceEntries([
  { ...provider, instanceId: ProviderInstanceId.make("codex-personal") },
])[0]!;

it("uses the same model and explicit effort on the backup host's own provider instance", () => {
  const selection = createModelSelection(source.instanceId, "gpt-5", [
    { id: "reasoningEffort", value: "high" },
  ]);
  expect(resolveScheduledTaskBackupModel(selection, source, [provider])).toEqual({
    ...selection,
    instanceId: provider.instanceId,
  });
  expect(
    resolveScheduledTaskBackupModel(createModelSelection(source.instanceId, "gpt-5"), source, [
      provider,
    ])?.options,
  ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
});

it("does not silently switch models, drivers, disabled accounts, or unsupported effort", () => {
  const selection = createModelSelection(source.instanceId, "gpt-5", [
    { id: "reasoningEffort", value: "high" },
  ]);
  for (const target of [
    { ...provider, models: [] },
    { ...provider, enabled: false },
    { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
    { ...provider, models: provider.models.map((model) => ({ ...model, capabilities: null })) },
  ])
    expect(resolveScheduledTaskBackupModel(selection, source, [target])).toBeNull();
  expect(
    resolveScheduledTaskBackupModel(selection, source, [
      { ...provider, instanceId: ProviderInstanceId.make("work") },
      { ...provider, instanceId: ProviderInstanceId.make("personal") },
    ]),
  ).toBeNull();
});

it("restores saved options only for the same model and provider instance", () => {
  const instanceId = ProviderInstanceId.make("codex-primary");
  const saved = createModelSelection(instanceId, "gpt-5", [
    { id: "reasoningEffort", value: "high" },
    { id: "temperature", value: "0.4" },
  ]);
  const other = resolveScheduledTaskModelSelection(instanceId, "gpt-other", saved, saved);
  expect(other.options).toBeUndefined();
  expect(resolveScheduledTaskModelSelection(instanceId, saved.model, other, saved)).toEqual(saved);
  const edited = createModelSelection(instanceId, saved.model, [
    { id: "reasoningEffort", value: "low" },
  ]);
  expect(resolveScheduledTaskModelSelection(instanceId, saved.model, edited, saved)).toEqual(
    edited,
  );
  expect(
    resolveScheduledTaskModelSelection(
      ProviderInstanceId.make("codex-backup"),
      saved.model,
      other,
      saved,
    ).options,
  ).toBeUndefined();
});
