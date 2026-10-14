// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentSupervisor as TestSupervisor,
  type EnvironmentRegistry as RegistryTypes,
  type EnvironmentSupervisor as SupervisorTypes,
} from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  IssueOperationError,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type IssueTemplate,
  type IssueTemplateList,
  type IssueTemplatesInput,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), bytes: 0 }));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    request: (tag: string, input: IssueTemplatesInput) =>
      Effect.gen(function* () {
        expect(tag).toBe(WS_METHODS.issuesTemplates);
        const supervisor = yield* TestSupervisor.EnvironmentSupervisor;
        const environmentId = supervisor.target.environmentId;
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await state.read({
              environmentId,
              input,
            });
            state.bytes += JSON.stringify(result).length;
            return result;
          },
          catch: (cause) =>
            new IssueOperationError({
              operation: "templates",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    requestGuarded: (tag: string, input: unknown) =>
      Effect.gen(function* () {
        expect(tag).toBe(WS_METHODS.issuesCreate);
        const supervisor = yield* TestSupervisor.EnvironmentSupervisor;
        const environmentId = supervisor.target.environmentId;
        return state.create({ environmentId, input });
      }),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/state/issues", async () => {
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const Session = await import("@t3tools/client-runtime/state/session");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const Option = await import("effect/Option");
  const { Atom } = await import("effect/reactivity");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" });
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = (environmentId: EnvironmentId) =>
          ({
            target: { environmentId },
            state: connection,
            session,
          }) as unknown as SupervisorTypes.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            ),
          followStream: (environmentId, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            ),
        } as RegistryTypes.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const factory = vi
    .spyOn(Session, "createEnvironmentSessionAtoms")
    .mockReturnValue({ ...sessions, sessionStateAtom: () => session });
  const issueEnvironment = createIssueEnvironmentAtoms(runtime);
  factory.mockRestore();
  const page = {
    hasMore: false,
    isPending: false,
    error: null,
    truncated: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    issueEnvironment,
    useIssueLabelCandidates: () => ({
      ...page,
      items: [{ id: "manual-label-id", name: "Manual label", color: null, description: null }],
    }),
    useIssueAssigneeCandidates: () => ({
      ...page,
      items: [{ id: "manual-user-id", login: "manual-user", name: null, avatarUrl: null }],
    }),
  };
});

import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";

const session = Atom.make(
  AsyncResult.success({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
  } satisfies AuthSessionState),
);
const source: IssueCreateScope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectTitle: "Project A",
  scope: {
    projectId: ProjectId.make("project-a"),
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.example",
    scope: "org/repo",
  },
  templates: true,
};
const template = (key: string, extra: Partial<IssueTemplate> = {}): IssueTemplate => ({
  key,
  name: `Template ${key}`,
  about: "",
  title: `Title ${key}`,
  body: `Body ${key}`,
  labels: [],
  assignees: [],
  ...extra,
});
const catalog: IssueTemplateList = {
  blankIssuesEnabled: false,
  templates: Array.from({ length: 100 }, (_, index) =>
    template(String(index), { title: "", body: "", contentDeferred: true }),
  ),
  contactLinks: [{ name: "Help", about: "Support", url: "https://gitlab.example/help" }],
};
const loaded = (key: string, extra: Partial<IssueTemplate> = {}): IssueTemplateList => ({
  blankIssuesEnabled: true,
  templates: [template(key, extra)],
});
function deferred() {
  let resolve!: (value: IssueTemplateList) => void;
  const promise = new Promise<IssueTemplateList>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
const created = vi.fn();
const render = (scopes: ReadonlyArray<IssueCreateScope> = [source], open = true) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueCreateDialog open={open} scopes={scopes} onOpenChange={vi.fn()} onCreated={created} />
      </RegistryContext.Provider>,
    ),
  );
const field = (kind: "title" | "body") =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#issue-create-${kind}`)!;
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create issue",
  )!;
async function type(kind: "title" | "body", value: string) {
  const input = field(kind);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      kind === "title" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openSelect(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}
async function choose(label: string, text: string) {
  const options = await openSelect(label);
  const option = options.find((entry) => entry.textContent === text)!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
async function attemptCreate() {
  await act(async () => {
    createButton().click();
    field("body")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.bytes = 0;
  state.create.mockReset().mockReturnValue({
    key: "1",
    displayKey: "#1",
    url: "https://gitlab.example/org/repo/-/issues/1",
  });
  state.read.mockReset().mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? catalog
      : input.templateKey
        ? loaded(input.templateKey)
        : {
            ...catalog,
            templates: catalog.templates.slice(0, 20).map((entry) => template(entry.key)),
          },
  );
  created.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

it("reads one small catalog only on open and one chosen body while keeping all 100 choices", async () => {
  await render([source], false);
  expect(state.read).not.toHaveBeenCalled();
  await render();
  expect(state.read).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: { ...source.scope, metadataOnly: true },
  });
  const options = await openSelect("Template");
  expect(options).toHaveLength(100);
  expect(options[99]!.textContent).toBe("Template 99");
  await act(async () => options[99]!.click());
  expect(state.read).toHaveBeenCalledTimes(2);
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, templateKey: "99" },
  });
  expect(field("body").value).toBe("Body 99");
  expect(document.body.textContent).toContain("Help");
  expect(state.bytes).toBeLessThan(25000);
  expect(await openSelect("Template")).toHaveLength(100);
});

it("keeps a late body from a previous template out of the selected draft", async () => {
  const first = deferred();
  const second = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? Promise.resolve(catalog)
      : input.templateKey === "0"
        ? first.promise
        : second.promise,
  );
  await render();
  await choose("Template", "Template 0");
  await attemptCreate();
  expect(createButton().disabled).toBe(true);
  expect(state.create).not.toHaveBeenCalled();
  await choose("Template", "Template 1");
  await act(async () => second.resolve(loaded("1")));
  expect(field("body").value).toBe("Body 1");
  await act(async () => first.resolve(loaded("0", { body: "Late secret for A" })));
  expect(field("body").value).toBe("Body 1");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 1",
      body: "Body 1",
      templateKey: "1",
      labels: [],
      assignees: [],
    },
  });
});

it.each(["environment", "host"])(
  "isolates a delayed body across a %s switch with the same template key",
  async (change) => {
    const first = deferred();
    const second = deferred();
    const alternative: IssueCreateScope = {
      ...source,
      projectTitle: "Project B",
      ...(change === "environment"
        ? { environmentId: EnvironmentId.make("environment-b") }
        : { scope: { ...source.scope, host: "second.gitlab.example" } }),
    };
    state.read.mockImplementation(
      ({ environmentId, input }: { environmentId: EnvironmentId; input: IssueTemplatesInput }) =>
        input.metadataOnly
          ? Promise.resolve(catalog)
          : environmentId === alternative.environmentId && input.host === alternative.scope.host
            ? second.promise
            : first.promise,
    );
    await render([source, alternative]);
    await choose("Template", "Template 0");
    await choose("Project", `${alternative.projectTitle} · ${alternative.scope.scope}`);
    await choose("Template", "Template 0");
    await act(async () => first.resolve(loaded("0", { body: "Late secret for A" })));
    expect(field("body").value).toBe("");
    await attemptCreate();
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => second.resolve(loaded("0", { title: "B", body: "B content" })));
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: alternative.environmentId,
      input: {
        ...alternative.scope,
        title: "B",
        body: "B content",
        templateKey: "0",
        labels: [],
        assignees: [],
      },
    });
  },
);

it.each(["failure", "missing", "deferred"])(
  "blocks a %s body response, keeps blank restrictions, and retries only that read",
  async (kind) => {
    let attempts = 0;
    state.read.mockImplementation(async ({ input }: { input: IssueTemplatesInput }) => {
      if (input.metadataOnly) return catalog;
      attempts += 1;
      if (attempts > 1) return loaded("0");
      if (kind === "failure") throw new Error("Body unavailable");
      return kind === "missing" ? loaded("wrong-key") : loaded("0", { contentDeferred: true });
    });
    await render();
    await type("title", "My draft");
    await choose("Template", "Template 0");
    await attemptCreate();
    expect(state.create).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(true);
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    expect(document.body.textContent).toContain(
      kind === "failure" ? "Body unavailable" : "template",
    );
    await render();
    expect(state.read).toHaveBeenCalledTimes(2);
    await act(async () => retry!.click());
    expect(state.read).toHaveBeenCalledTimes(3);
    expect(state.read).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      input: { ...source.scope, templateKey: "0" },
    });
    expect(field("body").value).toBe("Body 0");
    const options = await openSelect("Template");
    expect(options.some((option) => option.textContent === "Blank issue")).toBe(false);
  },
);

it("preserves newer text edits during a delayed read and applies the starting point only once", async () => {
  const body = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly ? Promise.resolve(catalog) : body.promise,
  );
  await render();
  await choose("Template", "Template 0");
  await type("title", "Typed while loading");
  await type("body", "Typed while loading");
  await type("body", "");
  await act(async () =>
    body.resolve(loaded("0", { labels: ["native-label"], assignees: ["native-user"] })),
  );
  expect(field("title").value).toBe("Typed while loading");
  expect(field("body").value).toBe("");
  await type("body", "My final body");
  await render();
  expect(field("body").value).toBe("My final body");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Typed while loading",
      body: "My final body",
      templateKey: "0",
      labels: ["native-label"],
      assignees: ["native-user"],
    },
  });
});

it("uses older inline templates without a selected read and preserves typed text", async () => {
  state.read.mockResolvedValue(
    loaded("inline", { labels: ["native-label"], assignees: ["native-user"] }),
  );
  await render();
  await type("title", "My title");
  await type("body", "My body");
  await choose("Template", "Template inline");
  expect(field("title").value).toBe("My title");
  expect(field("body").value).toBe("My body");
  expect(state.read).toHaveBeenCalledTimes(1);
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My title",
      body: "My body",
      templateKey: "inline",
      labels: ["native-label"],
      assignees: ["native-user"],
    },
  });
});

it("reuses the existing query retention when a deferred template is selected again", async () => {
  await render();
  await choose("Template", "Template 0");
  await choose("Template", "Template 1");
  await choose("Template", "Template 0");
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(state.read.mock.calls.map(([target]) => target.input.templateKey)).toEqual([
    undefined,
    "0",
    "1",
  ]);
});

it("keeps required form fields and their edits from the loaded template", async () => {
  state.read.mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? catalog
      : loaded("0", {
          fields: [
            {
              kind: "input",
              id: "required",
              label: "Required",
              description: null,
              required: true,
              placeholder: null,
              value: null,
            },
          ],
        }),
  );
  await render();
  await choose("Template", "Template 0");
  expect(createButton().disabled).toBe(true);
  expect(document.body.textContent).toContain("Fill in Required.");
  const input = document.querySelector<HTMLInputElement>("#issue-field-required")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "User value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render();
  expect(input.value).toBe("User value");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 0",
      body: "### Required\n\nUser value",
      templateKey: "0",
      labels: [],
      assignees: [],
    },
  });
});

it("shows a catalog read failure and retries its existing query", async () => {
  state.read.mockRejectedValueOnce(new Error("Catalog unavailable")).mockResolvedValue(catalog);
  await render();
  await type("title", "My draft");
  await attemptCreate();
  expect(state.create).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Catalog unavailable");
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(state.read).toHaveBeenCalledTimes(2);
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, metadataOnly: true },
  });
  expect(document.body.textContent).not.toContain("Catalog unavailable");
  expect(createButton().disabled).toBe(true);
  expect(await openSelect("Template")).toHaveLength(100);
});

it.each(["labels", "assignees"])(
  "preserves newer %s choices while a template body loads",
  async (kind) => {
    const body = deferred();
    state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
      input.metadataOnly ? Promise.resolve(catalog) : body.promise,
    );
    await render([{ ...source, labels: true, assignees: true }]);
    await choose("Template", "Template 0");
    const options = await openSelect(kind === "labels" ? "Change labels" : "Change assignees");
    const option = options.find((entry) =>
      entry.textContent?.includes(kind === "labels" ? "Manual label" : "manual-user"),
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await act(async () =>
      body.resolve(loaded("0", { labels: ["template-label"], assignees: ["template-user"] })),
    );
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: "Title 0",
        body: "Body 0",
        templateKey: "0",
        labels: kind === "labels" ? ["manual-label-id"] : ["template-label"],
        assignees: kind === "assignees" ? ["manual-user-id"] : ["template-user"],
      },
    });
  },
);
