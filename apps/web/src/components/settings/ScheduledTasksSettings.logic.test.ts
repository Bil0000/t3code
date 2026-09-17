import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveScheduledTaskModelSelection,
  resolveScheduledTaskBaseRef,
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
