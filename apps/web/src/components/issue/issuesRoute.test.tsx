// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  IssueListResult,
  WS_METHODS,
  ProjectId,
  type IssueListEntry,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  responses: new Map<string, AsyncResult.AsyncResult<IssueListResult, unknown>>(),
  read: vi.fn(),
  listPage: vi.fn(),
  search: { who: "all", status: "open" } as IssuesSearch,
  projects: [] as ReadonlyArray<ReturnType<typeof project>>,
  navigate: vi.fn(),
  environments: ["environment-a", "environment-b"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    serverConfig: { environment: { capabilities: { issues: true } } },
  })),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: object) => ({ options, useSearch: () => state.search }),
  useNavigate: () => state.navigate,
}));
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("@t3tools/client-runtime/state/issues", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const queries = Atom.family((key: string) =>
    Atom.make(() => {
      const { environmentId } = JSON.parse(key);
      state.read(environmentId);
      return state.responses.get(environmentId) ?? AsyncResult.initial(true);
    }).pipe(Atom.keepAlive),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/issues")>()),
    createIssueEnvironmentAtoms: () => ({
      list: (target: unknown) => queries(JSON.stringify(target)),
    }),
  };
});
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useIssuesSupported: () => true,
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS),
    environmentServerConfigsAtom: Atom.make(new Map()),
  };
});
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.listPage }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: (present: boolean, value: unknown) => ({ present, value }),
}));
vi.mock("~/components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/chat/PanelLayoutControls", () => ({ PanelLayoutControls: () => null }));
vi.mock("~/components/RightPanelTabs", () => ({
  RightPanelTabs: ({ children }: { children: ReactNode }) => (
    <aside aria-label="Issue details">{children}</aside>
  ),
}));
vi.mock("~/components/issue/IssueDetailPanel", () => ({ IssueDetailPanel: () => null }));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("~/components/issue/IssueCreateDialog", () => ({ IssueCreateDialog: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { issueEnvironment } from "~/state/issues";
import { Route, type IssuesSearch } from "../../routes/_chat.issues";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const project = (id: string) => ({
  id: ProjectId.make(id),
  environmentId: environmentA,
  title: `Project ${id}`,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
});
const issue = (key: string): IssueListEntry => ({
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key,
  displayKey: `#${key}`,
  title: `Issue ${key}`,
  url: `https://github.com/org/repo/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  labels: [],
  assignees: [],
  commentCount: 0,
  closedAt: null,
});
const answer = (entries: ReadonlyArray<IssueListEntry>): IssueListResult => ({
  entries,
  viewers: {},
  trackers: [
    {
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      projectCount: 1,
      configured: true,
      detail: null,
      capabilities: null,
    },
  ],
  nextCursors: {},
  errors: [],
});
let root: Root;
let container: HTMLDivElement;
const text = () => container.textContent;
const retry = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  );
async function refresh() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh issues"]')!.click(),
  );
}
const Page = Route.options.component!;
await Page.preload?.();

async function mount() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Page />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  state.responses.clear();
  state.read.mockClear();
  state.listPage.mockReset();
  state.projects = [];
  state.search = { who: "all", status: "open" };
  state.navigate.mockReset().mockImplementation(({ search }) => {
    state.search = search(state.search);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  appAtomRegistry.reset();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "shows a failed environment beside a successful answer (empty=%s) and retries",
  async (empty) => {
    state.responses.set(environmentA, AsyncResult.success(answer(empty ? [] : [issue("A")])));
    state.responses.set(
      environmentB,
      AsyncResult.failure(Cause.fail(new Error("Environment B is offline"))),
    );
    await mount();
    expect(text()).toContain("Environment B is offline");
    if (!empty) expect(text()).toContain("Issue A");
    expect(retry()).toBeDefined();
    state.responses.set(environmentB, AsyncResult.success(answer([issue("B")])));
    state.read.mockClear();
    await act(async () => retry()!.click());
    expect(state.read.mock.calls.map(([id]) => id).sort()).toEqual([environmentA, environmentB]);
    expect(text()).not.toContain("Environment B is offline");
    expect(text()).toContain("Issue B");
    if (!empty) expect(text()).toContain("Issue A");
    expect(retry()).toBeUndefined();
  },
);

it("keeps both environments' rows and the error after a failed refresh, then recovers", async () => {
  const first = answer([issue("A")]);
  const second = answer([issue("B")]);
  state.responses.set(environmentA, AsyncResult.success(first));
  state.responses.set(environmentB, AsyncResult.success(second));
  await mount();
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B");
  state.responses.set(
    environmentB,
    AsyncResult.failure(Cause.fail(new Error("Environment B refresh failed")), {
      previousSuccess: Option.some(AsyncResult.success(second)),
    }),
  );
  await refresh();
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B");
  expect(text()).toContain("Environment B refresh failed");
  expect(retry()).toBeDefined();
  state.responses.set(environmentB, AsyncResult.success(answer([issue("B reconnected")])));
  await act(async () => retry()!.click());
  expect(text()).toContain("Issue A");
  expect(text()).toContain("Issue B reconnected");
  expect(text()).not.toContain("Environment B refresh failed");
  expect(retry()).toBeUndefined();
});

const source = (id: string, host: string): NonNullable<IssueListResult["sources"]>[number] => ({
  projectId: ProjectId.make(id),
  projectTitle: `Project ${id}`,
  tracker: IssueTrackerKind.make("github"),
  host,
  scope: `org/${id}`,
  capabilities: {
    create: false,
    edit: false,
    comment: false,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
    states: [],
    closeReasons: [],
  },
});
const sourceAnswer = (sources: NonNullable<IssueListResult["sources"]>): IssueListResult => ({
  ...answer([]),
  sources,
  trackers: sources.map((source) => ({
    tracker: source.tracker,
    host: source.host,
    projectCount: 1,
    configured: true,
    detail: null,
    capabilities: source.capabilities,
  })),
});
async function openFilter(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}:"]`);
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
}
const projectBOption = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("Project B"),
  );

it("keeps another host's project selectable after a host-filtered answer", async () => {
  const sources = [source("A", "github.com"), source("B", "github.example")];
  state.projects = [project("A"), project("B")];
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer(sources)));
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by tracker");
  const host = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("github.com"),
  );
  expect(host).toBeDefined();
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer(sources.slice(0, 1))));
  await act(async () => host!.click());
  await mount();
  expect(state.search.host).toBe("github.com");
  await openFilter("Filter by project");
  expect(projectBOption()).toBeDefined();
  await act(async () => projectBOption()!.click());
  await mount();
  expect(
    container.querySelector('button[aria-label="Filter by project: Project B"]'),
  ).not.toBeNull();
  expect(state.search).toMatchObject({
    host: "github.com",
    environmentId: environmentA,
    projectId: "B",
  });
});

it("offers capable projects when the initial host-filtered answer has no full inventory", async () => {
  state.projects = [
    project("A"),
    project("B"),
    { ...project("C"), environmentId: EnvironmentId.make("unavailable") },
  ];
  state.search = { ...state.search, host: "github.com" };
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([source("A", "github.com")])));
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  await openFilter("Filter by project");
  expect(projectBOption()).toBeDefined();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Project A");
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Project C");
});

it("removes projects after an authoritative empty unfiltered answer", async () => {
  state.projects = [project("A"), project("B")];
  state.responses.set(
    environmentA,
    AsyncResult.success(sourceAnswer([source("A", "github.com"), source("B", "github.example")])),
  );
  state.responses.set(environmentB, AsyncResult.success(sourceAnswer([])));
  await mount();
  expect(container.querySelector('button[aria-label^="Filter by project:"]')).not.toBeNull();
  state.responses.set(environmentA, AsyncResult.success(sourceAnswer([])));
  await refresh();
  expect(container.querySelector('button[aria-label^="Filter by project:"]')).toBeNull();
});

it("toggles the selected issue panel with the existing keyboard shortcut", async () => {
  state.responses.set(environmentA, AsyncResult.success(answer([issue("A")])));
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const panel = () => container.querySelector('aside[aria-label="Issue details"]');
  const toggle = async (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(async () => document.dispatchEvent(event));
    return event;
  };
  expect((await toggle()).defaultPrevented).toBe(false);
  expect(panel()).toBeNull();
  const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Issue A"),
  )!;
  await act(async () => row.click());
  expect(panel()).not.toBeNull();
  expect((await toggle()).defaultPrevented).toBe(true);
  expect(panel()).toBeNull();
  expect(state.search.selectedProjectId).toBeUndefined();
  await toggle({ repeat: true });
  expect(panel()).toBeNull();
  await toggle();
  expect(panel()).not.toBeNull();
  expect(state.search.key).toBe("A");
  const palette = document.createElement("div");
  palette.setAttribute("data-command-palette", "");
  container.append(palette);
  expect((await toggle()).defaultPrevented).toBe(false);
  expect(panel()).not.toBeNull();
});

const decodeIssueList = Schema.decodeUnknownSync(IssueListResult);
it("labels both native mount scopes when their issue numbers match", async () => {
  const upper = {
    ...issue("42"),
    tracker: IssueTrackerKind.make("forgejo"),
    host: "forge.example",
    scope: "Root/Mount/acme/web",
  };
  const lower = { ...upper, scope: "Root/mount/acme/web" };
  const initial = answer([upper, lower]);
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...initial,
      trackers: [{ ...initial.trackers[0]!, tracker: upper.tracker, host: upper.host }],
    }),
  );
  state.responses.set(environmentB, AsyncResult.success(answer([])));
  await mount();
  const rows = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    button.textContent?.includes("Issue 42"),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain(upper.scope);
  expect(rows[1]!.textContent).toContain(lower.scope);
});

const RpcClient = await vi.importActual<typeof import("@t3tools/client-runtime/rpc")>(
  "../../../../../packages/client-runtime/src/rpc/client.ts",
);
it.each([
  { viewer: "B", empty: false },
  { viewer: "B", empty: true },
  { viewer: "A", empty: false },
])("restarts an accepted native viewer change once: %j", async ({ viewer, empty }) => {
  const { createIssueEnvironmentAtoms } = await vi.importActual<
    typeof import("@t3tools/client-runtime/state/issues")
  >("@t3tools/client-runtime/state/issues");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" } as const);
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = {
          state: connection,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const atoms = createIssueEnvironmentAtoms(runtime);
  const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
  state.listPage.mockImplementation((target) => atoms.listPage.run(appAtomRegistry, target));
  const environments = state.environments;
  state.environments = environments.slice(0, 1);
  const cursor = "github github.com org/repo";
  const failedCursor = "github github.com org/failed";
  const otherCursor = "gitlab gitlab.com org/repo";
  const other = { ...issue("G1"), tracker: IssueTrackerKind.make("gitlab"), host: "gitlab.com" };
  const failed = { ...issue("F1"), projectId: ProjectId.make("failed"), scope: "org/failed" };
  const initial = {
    ...answer([issue("A1"), failed, other]),
    viewers: { "github github.com": "A", "gitlab gitlab.com": "G" },
    nextCursors: { [cursor]: "2", [failedCursor]: "f2", [otherCursor]: "g2" },
  };
  initial.trackers = [
    ...initial.trackers,
    { ...initial.trackers[0]!, tracker: other.tracker, host: other.host },
  ];
  const pageTwo = {
    ...initial,
    entries: [],
    viewers: { ...initial.viewers, "github github.com": viewer },
    nextCursors: {},
    errors: [
      {
        projectId: failed.projectId,
        projectTitle: failed.projectTitle,
        tracker: failed.tracker,
        host: failed.host,
        message: "Failed native sibling",
      },
    ],
  };
  const firstForB = { ...pageTwo, entries: empty ? [] : [issue("B1")], errors: [] };
  const replies = [initial, pageTwo, ...(viewer === "B" ? [firstForB] : [])];
  const reads: Array<{ tag: string; input: unknown }> = [];
  const respond = ((tag: string, input: unknown) =>
    Effect.sync(() => {
      reads.push({ tag, input });
      return decodeIssueList(replies.shift());
    })) as unknown as typeof RpcClient.request;
  const request = vi.spyOn(RpcClient, "request").mockImplementation(respond);
  const guarded = vi.spyOn(RpcClient, "requestGuarded");
  guarded.mockImplementation(
    respond as unknown as Parameters<typeof guarded.mockImplementation>[0],
  );
  try {
    await mount();
    expect(text()).toContain("Issue A1");
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    expect(reads.map(({ tag }) => tag)).toEqual(
      Array(viewer === "B" ? 3 : 2).fill(WS_METHODS.issuesList),
    );
    expect(reads[1]!.input).toMatchObject({ cursors: { [cursor]: "2", [failedCursor]: "f2" } });
    if (viewer === "B") {
      expect(reads[2]!.input).toMatchObject({ projectId: "project", host: "github.com" });
      expect(reads[2]!.input).not.toHaveProperty("cursors");
      expect(text()).not.toContain("Issue A1");
      if (!empty) expect(text()).toContain("Issue B1");
    } else expect(text()).toContain("Issue A1");
    expect(text()).toContain("Issue G1");
    expect(text()).toContain("Issue F1");
    expect(text()).toContain("Failed native sibling");
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Load more",
      ),
    ).toHaveLength(2);
    await mount();
    expect(reads).toHaveLength(viewer === "B" ? 3 : 2);
    expect(replies).toEqual([]);
  } finally {
    state.environments = environments;
    list.mockRestore();
    request.mockRestore();
    guarded.mockRestore();
  }
});
