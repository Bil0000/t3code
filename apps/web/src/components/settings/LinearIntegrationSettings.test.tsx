import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { primary } = vi.hoisted(() => ({ primary: vi.fn() }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironment: primary }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../issue/LinearConnectionDialog", () => ({
  LinearConnectionDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <div role="dialog" aria-label="Linear">
      <button onClick={() => onOpenChange(false)}>Done</button>
    </div>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));

import { LinearIntegrationSettings } from "./LinearIntegrationSettings";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("opens and closes Linear setup from integrations", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  primary.mockReturnValue({
    environmentId: "test",
    serverConfig: { environment: { capabilities: { issues: true } } },
  });
  await act(() => {
    renderer = create(<LinearIntegrationSettings />);
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  await act(() => renderer.root.findByType("button").props.onClick());
  expect(renderer.root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("Linear");
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Done"))!
      .props.onClick(),
  );
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});

it("disables setup without a supported environment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  primary.mockReturnValue(null);
  await act(() => {
    renderer = create(<LinearIntegrationSettings />);
  });
  expect(renderer.root.findByType("button").props.disabled).toBe(true);
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});
