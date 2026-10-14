// @vitest-environment jsdom

import type {
  EnvironmentRegistry as EnvironmentRegistryTypes,
  EnvironmentSupervisor as EnvironmentSupervisorTypes,
} from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type IssueTemplateList,
  type IssueCandidates,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  toast: vi.fn(),
  nativeCreate: vi.fn(),
  metadata: null as (IssueTemplateList & Pick<IssueCandidates, "issueTypes">) | null,
}));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    requestGuarded: (tag: string, input: unknown) => {
      expect(tag).toBe(WS_METHODS.issuesCreate);
      return Effect.sync(() => state.nativeCreate(input));
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.metadata,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/state/issues", async () => {
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const Session = await import("@t3tools/client-runtime/state/session");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const supervisor = {} as EnvironmentSupervisorTypes.EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistryTypes.EnvironmentRegistry["Service"]),
    ),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const sessionFactory = vi.spyOn(Session, "createEnvironmentSessionAtoms").mockReturnValue({
    ...sessions,
    sessionStateAtom: () => session,
  });
  const issueEnvironment = createIssueEnvironmentAtoms(runtime);
  sessionFactory.mockRestore();
  return { issueEnvironment };
});

import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";

const sessionState: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
  permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
};
const session = Atom.make(AsyncResult.success(sessionState));
const sourceA: IssueCreateScope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectTitle: "Project A",
  scope: {
    projectId: ProjectId.make("project-a"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.example",
    scope: "org/A",
  },
  templates: false,
};
const sourceB: IssueCreateScope = {
  ...sourceA,
  projectTitle: "Project B",
  scope: { ...sourceA.scope, projectId: ProjectId.make("project-b"), scope: "org/B" },
};
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
const created = vi.fn();
const closed = vi.fn();
const nativeCreate = state.nativeCreate;
const render = (
  scopes: ReadonlyArray<IssueCreateScope>,
  parent?: { key: string; displayKey: string },
) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueCreateDialog
          open
          parent={parent ?? null}
          scopes={scopes}
          onCreated={created}
          onOpenChange={closed}
        />
      </RegistryContext.Provider>,
    ),
  );
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create issue",
  )!;
async function draft() {
  const input = document.querySelector<HTMLInputElement>("#issue-create-title")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Draft meant for A",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, title: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
    entry.textContent?.includes(title),
  )!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.metadata = null;
  registry = AtomRegistry.make();
  registry.set(session, AsyncResult.success(sessionState));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  created.mockReset();
  closed.mockReset();
  nativeCreate.mockReset().mockReturnValue({
    key: "7",
    displayKey: "#7",
    url: "https://github.example/org/A/issues/7",
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: "repository", replacement: sourceB },
  {
    name: "environment",
    replacement: { ...sourceA, environmentId: (sourceB.environmentId + "-other") as EnvironmentId },
  },
  { name: "host", replacement: { ...sourceA, scope: { ...sourceA.scope, host: "other.example" } } },
  {
    name: "tracker",
    replacement: {
      ...sourceA,
      scope: { ...sourceA.scope, tracker: IssueTrackerKind.make("gitlab") },
    },
  },
])(
  "blocks a removed $name until the writer chooses the remaining source",
  async ({ replacement }) => {
    await render([sourceA, replacement]);
    await draft();
    await render([replacement]);
    await act(async () => createButton().click());
    expect(nativeCreate).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#issue-create-title")!.value).toBe(
      "Draft meant for A",
    );
    await choose("Project", replacement.projectTitle);
    await act(async () => createButton().click());
    expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
      ...replacement.scope,
      title: "Draft meant for A",
      body: "",
      labels: [],
      assignees: [],
    });
    expect(created).toHaveBeenCalledWith(replacement, expect.objectContaining({ key: "7" }));
  },
);

it("keeps the selected native scope after reorder and project representative replacement", async () => {
  await render([sourceA, sourceB]);
  await draft();
  const rebound = {
    ...sourceA,
    projectTitle: "Another local project for A",
    scope: {
      ...sourceA.scope,
      projectId: ProjectId.make("project-a-representative"),
      host: "GITHUB.EXAMPLE",
    },
  };
  await render([sourceB, rebound]);
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
    ...rebound.scope,
    title: "Draft meant for A",
    body: "",
    labels: [],
    assignees: [],
  });
  expect(created).toHaveBeenCalledWith(rebound, expect.objectContaining({ key: "7" }));
});

it("keeps the write permission guard after source selection", async () => {
  await render([sourceA, sourceB]);
  await draft();
  await choose("Project", sourceB.projectTitle);
  await act(async () =>
    registry.set(session, AsyncResult.success({ ...sessionState, permissions: [], scopes: [] })),
  );
  await act(async () => createButton().click());
  expect(createButton().disabled).toBe(true);
  expect(nativeCreate).not.toHaveBeenCalled();
});

it("preselects the first source when sources arrive after the dialog mounts", async () => {
  await render([]);
  await render([sourceA]);
  await draft();
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(sourceA.scope));
});

it("keeps native template, parent and issue-type metadata through source reorder", async () => {
  state.metadata = {
    blankIssuesEnabled: false,
    templates: [
      {
        key: "bug",
        name: "Bug",
        about: "",
        title: "Template title",
        body: "Template body",
        labels: ["bug"],
        assignees: ["native-user"],
      },
    ],
    issueTypes: [{ id: "native-bug-type", name: "Bug" }],
  };
  const nativeSource = { ...sourceA, templates: true, createIssueTypes: true };
  const parent = { key: "native-parent", displayKey: "#5" };
  await render([nativeSource, sourceB], parent);
  await draft();
  await choose("Template", "Bug");
  await render([sourceB, nativeSource], parent);
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
    ...nativeSource.scope,
    title: "Draft meant for A",
    body: "Template body",
    templateKey: "bug",
    parentKey: parent.key,
    issueType: "native-bug-type",
    labels: ["bug"],
    assignees: ["native-user"],
  });
});
