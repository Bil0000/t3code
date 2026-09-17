import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

const state = vi.hoisted(() => ({
  save: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "server",
  useEnvironment: (environmentId: string) => ({ environmentId, label: environmentId }),
  useEnvironments: () => ({ environments: [{ environmentId: "server", label: "Server" }] }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () =>
    ["server", "remote"].map((environmentId) => ({
      id: "project",
      environmentId,
      title: "Project",
      workspaceRoot: "/repo",
    })),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => null, scheduledTasksLive: () => "tasks" },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { listRefs: () => "refs" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "tasks" ? { tasks: [] } : { refs: [{ name: "develop", isDefault: true }] },
    error: null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => [
    { instanceId: "codex", driverKind: "codex", models: [{ slug: "gpt-5.4" }] },
  ],
  applyProviderInstanceSettings: (entries: unknown) => entries,
  sortProviderInstanceEntries: (entries: unknown) => entries,
}));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => new Map() }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./ScheduledTaskBranchPicker", () => ({ ScheduledTaskBranchPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({
  TraitsPicker: ({
    onModelOptionsChange,
  }: {
    onModelOptionsChange: (options: { id: string; value: string }[]) => void;
  }) => (
    <button onClick={() => onModelOptionsChange([{ id: "reasoningEffort", value: "high" }])}>
      High reasoning
    </button>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <>
      {headerAction}
      {children}
    </>
  ),
  useRelativeTimeTick: () => {},
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogClose: "button",
  DialogDescription: "p",
  DialogFooter: "div",
  DialogHeader: "div",
  DialogPanel: "div",
  DialogPopup: "div",
  DialogTitle: "h2",
}));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "span",
  SelectPopup: "div",
  SelectTrigger: "button",
  SelectValue: "span",
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each(["server", "remote"])(
  "saves reasoning and repository default on %s",
  async (environmentId) => {
    state.save.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    act(() => {
      renderer = create(
        <ScheduledTasksSettings environmentId={EnvironmentId.make(environmentId)} />,
      );
    });
    const click = (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes(label))!
        .props.onClick();
    act(() => click("New"));
    act(() => {
      renderer.root
        .findByProps({ id: "scheduled-task-title" })
        .props.onChange({ target: { value: "Review" } });
      renderer.root
        .findByProps({ id: "scheduled-task-prompt" })
        .props.onChange({ target: { value: "Review changes" } });
      click("High reasoning");
    });
    await act(async () => {
      click("Create task");
    });
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        input: expect.objectContaining({
          workspaceStrategy: { type: "worktree", baseRef: "develop", startFromOrigin: true },
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      }),
    );
  },
);
