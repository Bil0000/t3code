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
  search: { who: "all", status: "open" } as Record<string, string>,
  projects: [] as ReadonlyArray<object>,
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
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: () => ({ present: false, value: null }),
}));
vi.mock("~/components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/issue/IssueDetailPanel", () => ({ IssueDetailPanel: () => null }));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("~/components/issue/IssueCreateDialog", () => ({ IssueCreateDialog: () => null }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Route } from "~/routes/_chat.issues";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
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
  state.responses.clear();
  state.read.mockClear();
  state.search = { who: "all", status: "open" };
  state.projects = [];
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

it("keeps every project selectable while the list is narrowed to one tracker host", async () => {
  const project = (id: string) => ({
    id: ProjectId.make(id),
    environmentId: environmentA,
    title: id,
    workspaceRoot: `/work/${id}`,
  });
  const source = (id: string, host: string) => ({
    projectId: ProjectId.make(id),
    projectTitle: id,
    tracker: IssueTrackerKind.make("github"),
    host,
    scope: `org/${id}`,
    capabilities: { create: false } as NonNullable<
      IssueListResult["sources"]
    >[number]["capabilities"],
  });
  state.projects = [project("Project A"), project("Project B")];
  state.responses.set(
    environmentA,
    AsyncResult.success({
      ...answer([]),
      sources: [source("Project A", "github.com"), source("Project B", "ghe.example.com")],
    }),
  );
  const projectChoices = async () => {
    const menu = container.querySelector<HTMLButtonElement>('[aria-label^="Filter by project"]');
    if (menu === null) return [];
    await act(async () => menu.click());
    const choices = [...document.querySelectorAll('[role="menuitemradio"] .truncate')].map(
      (label) => label.textContent,
    );
    await act(async () => menu.click());
    return choices;
  };
  await mount();
  expect(await projectChoices()).toEqual(["All projects", "Project A", "Project B"]);
  state.search = { ...state.search, host: "github.com" };
  state.responses.set(
    environmentA,
    AsyncResult.success({ ...answer([]), sources: [source("Project A", "github.com")] }),
  );
  await mount();
  expect(await projectChoices()).toEqual(["All projects", "Project A", "Project B"]);
});
