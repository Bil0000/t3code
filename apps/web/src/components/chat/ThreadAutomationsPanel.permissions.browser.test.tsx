import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  toggle: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  tasks: [] as unknown[],
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled
        ? state.toggle
        : command === serverEnvironment.deleteScheduledTask
          ? state.remove
          : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: { tasks: state.tasks }, error: null })) as never,
}));

import { act, render as renderUi } from "../../../test/render";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
} as ScheduledTask;
const watcher = {
  ...task,
  id: ScheduledTaskId.make("watcher"),
  title: "Release watcher",
  lastRunStatus: "succeeded",
  lastRunAt: null,
  lastRunError: null,
  watch: {
    source: { type: "jira", baseUrl: "https://acme.atlassian.net", jql: "project = PRIVATE" },
    filters: [],
    maxConcurrentRuns: 1,
    initializedAt: "2026-10-21T10:00:00.000Z",
    lastFiredAt: null,
    fireCount: 0,
    pendingCount: 0,
    activeRunCount: 0,
  },
} as ScheduledTask;

async function setup() {
  state.allowed = true;
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  state.tasks = [task];

  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  const container = screen.container;
  async function renderPanel() {
    await act(
      async () =>
        await screen.rerender(
          <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
        ),
    );
  }

  const byLabel = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  const environment = stack.move();
  return {
    renderPanel,
    byLabel,
    container,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}
it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "checks and stops a watcher only with task permission (%s)",
  async (allowed) => {
    await using fixture = await setup();
    const { renderPanel, byLabel } = fixture;
    using _confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    state.tasks = [watcher];
    state.allowed = allowed;
    await renderPanel();
    expect(fixture.container.textContent).not.toContain("PRIVATE");
    expect(fixture.container.querySelector('[aria-label="Edit Release watcher"]')).toBeNull();
    await act(async () => byLabel("Check Release watcher now").click());
    await act(async () => byLabel("Stop watching Release watcher").click());
    expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(state.remove).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);

it("keeps a watcher when stopping is not confirmed", async () => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  using _confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  state.tasks = [watcher];
  await renderPanel();
  await act(async () => byLabel("Stop watching Release watcher").click());
  expect(state.remove).not.toHaveBeenCalled();
});
