import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

const state = vi.hoisted(() => ({
  save: vi.fn(async () => ({ _tag: "Success" })),
  tasks: [] as ScheduledTask[],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "gpt-5.4" }],
    },
  ],
}));
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
    data:
      query === null
        ? null
        : query === "tasks"
          ? { tasks: state.tasks, failoverAvailable: true }
          : { refs: [{ name: "develop", isDefault: true }] },
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
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: "span",
  TooltipPopup: "span",
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const taskFixture = decodeTask({
  id: "task",
  title: "Review",
  prompt: "Review changes",
  enabled: false,
  schedule: { type: "interval", everyMs: 60000 },
  failover: {
    groupId: "e6d5501c-e8e8-4a76-b06d-776d170ac39a",
    revision: "0e2a7a35-2e09-4b87-808b-1604601e6cf2",
    environmentIds: ["server", "remote"],
    timeZone: "UTC",
  },
  projectId: "project",
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  state.tasks = [];
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

it.each([false, true])(
  "removes the backup only after a successful detach (failure: %s)",
  async (fail) => {
    state.save.mockClear();
    const task = taskFixture;
    state.tasks = [task];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    act(() => {
      renderer = create(
        <ScheduledTasksSettings environmentId={EnvironmentId.make("server")} taskId={task.id} />,
      );
    });
    act(() =>
      renderer.root.findByProps({ id: "scheduled-task-backup" }).props.onCheckedChange(false),
    );
    if (fail) state.save.mockRejectedValueOnce(new Error("Host unavailable"));
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Save task"))!
        .props.onClick();
    });
    expect(state.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        environmentId: "server",
        input: expect.objectContaining({ failover: null }),
      }),
    );
    expect(state.save).toHaveBeenCalledTimes(fail ? 1 : 2);
    if (!fail)
      expect(state.save).toHaveBeenNthCalledWith(2, {
        environmentId: "remote",
        input: { id: task.id },
      });
  },
);

it("keeps an enabled standalone task running when backup configuration fails", async () => {
  state.save.mockClear();
  const task = { ...taskFixture, enabled: true, failover: null };
  state.tasks = [task];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <ScheduledTasksSettings environmentId={EnvironmentId.make("server")} taskId={task.id} />,
    );
  });
  act(() => renderer.root.findByProps({ id: "scheduled-task-backup" }).props.onCheckedChange(true));
  act(() =>
    renderer.root
      .findByProps({ "aria-label": "Backup host" })
      .parent!.props.onValueChange("remote"),
  );
  act(() =>
    renderer.root
      .findByProps({ "aria-label": "Backup project" })
      .parent!.props.onValueChange("project"),
  );
  let enabled = true;
  state.save.mockImplementation(async (...args: unknown[]) => {
    const { input } = args[0] as { input: { groupId?: string; enabled?: boolean } };
    if (input.groupId) throw new Error("Coordinator unavailable");
    enabled = input.enabled ?? enabled;
    return { _tag: "Success" };
  });
  try {
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Save task"))!
        .props.onClick();
    });
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ environmentIds: ["server", "remote"] }),
      }),
    );
    expect(enabled).toBe(true);
    expect(state.save).toHaveBeenCalledTimes(1);
  } finally {
    state.save.mockResolvedValue({ _tag: "Success" });
  }
});
