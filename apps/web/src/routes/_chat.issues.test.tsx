// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  responses: new Map<string, AsyncResult.AsyncResult<IssueListResult, unknown>>(),
  read: vi.fn(),
  search: { who: "all", status: "open" } as IssuesSearch,
  projects: [] as ReadonlyArray<ReturnType<typeof project>>,
  navigate: vi.fn(),
  environments: ["environment-a", "environment-b"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    serverConfig: { environment: { capabilities: { issues: true } } },
  })),
}));
vi.mock("@tanstack/react-router", () => ({
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
  return {
    primaryServerKeybindingsAtom: Atom.make([]),
    environmentServerConfigsAtom: Atom.make(new Map()),
  };
});
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/keybindings", () => ({ shortcutLabelForCommand: () => "" }));
vi.mock("~/panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: () => ({ present: false, value: null }),
}));
vi.mock("~/components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/chat/PanelLayoutControls", () => ({ PanelLayoutControls: () => null }));
vi.mock("~/components/RightPanelTabs", () => ({ RightPanelTabs: () => null }));
vi.mock("~/components/issue/IssueDetailPanel", () => ({ IssueDetailPanel: () => null }));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("~/components/issue/IssueCreateDialog", () => ({ IssueCreateDialog: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Route, type IssuesSearch } from "./_chat.issues";

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
async function mount() {
  const Page = Route.options.component!;
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
  state.responses.clear();
  state.read.mockClear();
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
