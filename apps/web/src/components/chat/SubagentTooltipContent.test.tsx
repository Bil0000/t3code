import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { SubagentTooltipContent } from "./SubagentTooltipContent";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-18T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "OpenAI GPT-5.4",
      shortName: "OpenAI GPT-5.4",
      subProvider: "OpenAI",
      aliases: ["default-model"],
      isCustom: false,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
};

afterEach(() => vi.unstubAllGlobals());

it.each([
  [null, true, "GPT-5.4"],
  ["", true, "GPT-5.4"],
  ["   ", true, "GPT-5.4"],
  ["default-model", false, "GPT-5.4"],
  ["gpt-5.4", false, "GPT-5.4"],
  ["gpt-5.5", true, "GPT-5.5"],
  ["custom/model-v1", true, "custom/model-v1"],
  [null, false, "Not reported"],
] as const)("displays model %s with child=%s as %s", async (model, hasChild, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SubagentTooltipContent
        title="Patch delivery"
        model={model}
        provider={provider}
        childThread={hasChild ? makeThreadProjectionFixture().thread : undefined}
        status="running"
      />,
    );
  });
  try {
    expect(renderer.root.findAllByType("dd")[0]?.children.join("")).toBe(expected);
  } finally {
    await act(async () => renderer.unmount());
  }
});
