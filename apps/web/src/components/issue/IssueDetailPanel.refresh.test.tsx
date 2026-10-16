// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  IssueDetail,
  IssueHierarchyPage,
  IssueHistoryPage,
  IssueLinkedPullRequestsPage,
  IssueDependenciesPage,
  type IssueDependencyDirection,
  type AuthSessionState,
  type IssueRef,
} from "@t3tools/contracts";
import type {
  EnvironmentRegistry as Registry,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  read: vi.fn<
    (
      tag: string,
      input: IssueRef & { cursor?: string; direction?: IssueDependencyDirection },
    ) => unknown
  >(),
  writes: vi.fn(),
  newer: false,
  failedDetail: false,
  failedRelated: false,
  failedDependencies: false,
}));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  const { IssueOperationError, WS_METHODS } = await import("@t3tools/contracts");
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/rpc")>()),
    request: (
      tag: string,
      input: IssueRef & { cursor?: string; direction?: IssueDependencyDirection },
    ) =>
      Effect.gen(function* () {
        const value = yield* Effect.promise(async () => state.read(tag, input));
        if (tag === WS_METHODS.issuesDetail && state.failedDetail)
          return yield* new IssueOperationError({
            operation: "getIssue",
            detail: "Native detail unavailable",
          });
        if (
          (tag === WS_METHODS.issuesLinkedPullRequests || tag === WS_METHODS.issuesHierarchy) &&
          state.failedRelated
        )
          return yield* new IssueOperationError({
            operation: tag,
            detail: "Native related data unavailable",
          });
        if (tag === WS_METHODS.issuesDependencies && state.failedDependencies)
          return yield* new IssueOperationError({
            operation: "dependencies",
            detail: "Native dependency read failed",
          });
        return value;
      }),
    requestGuarded: (tag: string, input: unknown) => Effect.sync(() => state.writes(tag, input)),
  };
});
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Stream = await import("effect/Stream");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* () {
          const supervisor = {
            state: yield* SubscriptionRef.make({ phase: "connected" }),
            session: yield* SubscriptionRef.make(Option.some({})),
          } as unknown as Supervisor.EnvironmentSupervisor["Service"];
          return EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as Registry.EnvironmentRegistry["Service"]);
        }),
      ),
    ),
  };
});
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AuthOrchestrationReadScope, AuthSourceControlWriteScope } =
    await import("@t3tools/contracts");
  const session = Atom.make(
    AsyncResult.success<AuthSessionState>({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
      permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    }),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/session")>()),
    createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => session }),
  };
});
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: vi.fn() }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { IssueDetailPanel } from "./IssueDetailPanel";

const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const decodeHierarchy = Schema.decodeUnknownSync(IssueHierarchyPage);
const decodeHistory = Schema.decodeUnknownSync(IssueHistoryPage);
const decodeLinkedPullRequests = Schema.decodeUnknownSync(IssueLinkedPullRequestsPage);
const environmentId = EnvironmentId.make("refresh-environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
const capabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: true,
  events: false,
  subIssues: true,
  updateParent: false,
  states: [],
  closeReasons: [],
  search: true,
};
const issue = {
  ...reference,
  projectTitle: "Project",
  displayKey: "#1",
  title: "Issue",
  body: "",
  url: "https://github.com/org/repo/issues/1",
  author: null,
  viewer: "viewer",
  state: { category: "open", name: "open" },
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  closedAt: null,
  labels: [],
  assignees: [],
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
  commentCount: 0,
  writable: true,
  viewerPermissions: {
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    setState: false,
  },
  capabilities,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.read.mockReset();
  state.writes.mockReset();
  state.newer = false;
  state.failedDetail = false;
  state.failedRelated = false;
  state.failedDependencies = false;
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
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === label,
  )!;

it.each(["supported", "unmounted", "unsupported", "failed-detail", "failed-related"])(
  "refreshes only supported mounted first pages from the header (%s)",
  async (kind) => {
    const supported = kind !== "unsupported";
    state.failedDetail = kind === "failed-detail";
    state.failedRelated = kind === "failed-related";
    state.read.mockImplementation((tag, input) => {
      const prefix = state.newer ? "New" : "Old";
      const number = input.cursor === undefined ? (state.newer ? 3 : 2) : 4;
      switch (tag) {
        case WS_METHODS.issuesDetail:
          return decodeDetail({
            ...issue,
            title: `${prefix} issue`,
            capabilities: {
              ...capabilities,
              linkedPullRequests: supported,
              subIssues: supported,
              events: kind === "unmounted",
            },
          });
        case WS_METHODS.issuesLinkedPullRequests:
          return decodeLinkedPullRequests({
            items: [
              {
                provider: "github",
                host: "github.com",
                repository: "org/repo",
                number,
                title: `${prefix} PR${input.cursor ? " tail" : ""}`,
                url: `https://github.com/org/repo/pull/${number}`,
                state: "open",
                isDraft: false,
                closesIssue: true,
              },
            ],
            nextCursor: input.cursor === undefined ? "pr-tail" : null,
          });
        case WS_METHODS.issuesHierarchy:
          return decodeHierarchy({
            parent: null,
            children: {
              items: [
                {
                  scope: "org/repo",
                  key: String(number),
                  displayKey: `#${number}`,
                  title: `${prefix} child${input.cursor ? " tail" : ""}`,
                  url: `https://github.com/org/repo/issues/${number}`,
                  state: { category: "open", name: "open" },
                },
              ],
              nextCursor: input.cursor === undefined ? "child-tail" : null,
            },
          });
        case WS_METHODS.issuesHistory:
          return decodeHistory({ items: [], nextCursor: null });
        default:
          throw new Error(`Unexpected RPC ${tag}`);
      }
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={reference} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
    });
    if (state.failedDetail) {
      expect(container.textContent).toContain("Could not load this issue");
      expect(container.querySelector('[aria-label="Refresh issue"]')).toBeNull();
      expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([WS_METHODS.issuesDetail]);
      let release = () => {};
      state.read.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(null))),
      );
      await act(async () => button("Retry").click());
      expect(container.textContent).not.toContain("Could not load this issue");
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([
        WS_METHODS.issuesDetail,
        WS_METHODS.issuesDetail,
      ]);
      release();
      return;
    }
    if (supported) {
      await act(async () => {
        await Promise.all([
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.linkedPullRequests({ environmentId, input: reference }),
          ),
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.hierarchy({ environmentId, input: reference }),
          ),
        ]);
      });
      if (!state.failedRelated) {
        expect(container.textContent).toContain("Old PR");
        expect(container.textContent).toContain("Old child");
        await act(async () => button("Load more pull requests").click());
        await act(async () => button("Load more sub-issues").click());
        expect(container.textContent).toContain("Old PR tail");
        expect(container.textContent).toContain("Old child tail");
      }
    }
    if (kind === "unmounted") {
      await act(async () => button("History").click());
      await act(async () => {
        await executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.history({ environmentId, input: reference }),
        );
      });
      expect(container.querySelector('[aria-label="Hierarchy"]')).toBeNull();
    }
    const before = state.read.mock.calls.length;
    state.newer = true;
    state.failedRelated = false;
    state.failedDependencies = false;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh issue"]')!.click(),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
    });
    expect(container.textContent).toContain("New issue");
    if (supported && kind !== "unmounted") {
      expect(container.textContent).toContain("New PR");
      expect(container.textContent).toContain("New child");
      expect(container.textContent).not.toContain("Old PR tail");
      expect(container.textContent).not.toContain("Old child tail");
    }
    const expected = [
      WS_METHODS.issuesDetail,
      ...(supported ? [WS_METHODS.issuesLinkedPullRequests] : []),
      ...(supported && kind !== "unmounted" ? [WS_METHODS.issuesHierarchy] : []),
      ...(kind === "unmounted" ? [WS_METHODS.issuesHistory] : []),
    ];
    const calls = state.read.mock.calls.slice(before);
    expect(calls.map(([tag]) => tag).toSorted()).toEqual(expected.toSorted());
    for (const [, input] of calls) expect(input).toEqual(reference);
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it("reads one dependency page per direction, accumulates pages and retries a failed read", async () => {
  const nativeRef = { ...reference, connectionId: "Account-B" };
  const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        ...nativeRef,
        capabilities: {
          ...capabilities,
          linkedPullRequests: false,
          subIssues: false,
          dependencies: true,
        },
      });
    if (tag === WS_METHODS.issuesDependencies)
      return decodeDependencies({
        items: [
          {
            scope: "native/repo",
            key: input.cursor ? "3" : "2",
            displayKey: input.cursor ? "!3" : "!2",
            title: input.cursor ? "Next native PR" : "First native PR",
            kind: "pull-request",
            url: "https://native.example/pulls/2",
            state: { category: "open", name: "open" },
          },
        ],
        nextCursor: input.cursor ? null : "native-tail",
      });
    throw new Error("Unexpected RPC " + tag);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: nativeRef }),
    );
  });
  await act(async () => {
    await Promise.all(
      (["blocks", "blocked-by"] as const).map((direction) =>
        executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.dependencies({
            environmentId,
            input: { ...nativeRef, direction, limit: 100 },
          }),
        ),
      ),
    );
  });
  const reads = state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesDependencies);
  expect(reads.map(([, input]) => input)).toEqual(
    expect.arrayContaining([
      { ...nativeRef, direction: "blocks", limit: 100 },
      { ...nativeRef, direction: "blocked-by", limit: 100 },
    ]),
  );
  expect(reads).toHaveLength(2);
  const blocks = container.querySelector('[aria-label="Blocks"]')!;
  const blockedBy = container.querySelector('[aria-label="Blocked by"]')!;
  expect(blocks.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://native.example/pulls/2");
  expect(blocks.textContent).toContain("First native PR");
  await act(async () =>
    [...blocks.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent === "Load more dependencies")!
      .click(),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.dependencies({
        environmentId,
        input: { ...nativeRef, direction: "blocks", limit: 100, cursor: "native-tail" },
      }),
    );
  });
  expect(blocks.textContent).toContain("Next native PR");
  expect(blocks.textContent).toContain("First native PR");
  expect(blockedBy.textContent).toContain("First native PR");
  state.failedDependencies = true;
  await act(async () => {
    appAtomRegistry.refresh(
      issueEnvironment.dependencies({
        environmentId,
        input: { ...nativeRef, direction: "blocked-by", limit: 100 },
      }),
    );
  });
  expect(blockedBy.textContent).toContain("Native dependency read failed");
  state.failedDependencies = false;
  await act(async () =>
    [...blockedBy.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent === "Retry dependencies")!
      .click(),
  );
  expect(blockedBy.textContent).not.toContain("Native dependency read failed");
  expect(state.writes).not.toHaveBeenCalled();
});

it.each(["success", "failed-refresh", "unsupported", "unmounted"])(
  "refreshes dependency directions from the first page after continuation (%s)",
  async (kind) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    const supported = kind !== "unsupported";
    const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
    state.read.mockImplementation((tag, input) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          title: state.newer ? "New issue" : "Old issue",
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssues: false,
            events: true,
            dependencies: supported,
          },
        });
      if (tag === WS_METHODS.issuesHistory) return decodeHistory({ items: [], nextCursor: null });
      if (tag === WS_METHODS.issuesDependencies)
        return decodeDependencies({
          items: Array.from({ length: input.cursor ? 1 : 50 }, (_, index) => ({
            scope: "native/repo",
            key: input.cursor ? "51" : String(index + 1),
            displayKey: input.cursor ? "#51" : `#${index + 1}`,
            title: `${state.newer ? "New" : "Old"} ${input.direction} ${input.cursor ? "tail" : index + 1}`,
            kind: "pull-request",
            url: `https://native.example/pulls/${input.cursor ? "51" : index + 1}`,
            state: { category: "open", name: "open" },
          })),
          nextCursor: input.cursor ? null : "native-tail",
        });
      throw new Error(`Unexpected RPC ${tag}`);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    if (supported) {
      await act(async () => {
        await Promise.all(
          (["blocks", "blocked-by"] as const).map((direction) =>
            executeAtomQuery(
              appAtomRegistry,
              issueEnvironment.dependencies({
                environmentId,
                input: { ...nativeRef, direction, limit: 100 },
              }),
            ),
          ),
        );
      });
      for (const title of ["Blocks", "Blocked by"]) {
        const section = container.querySelector(`[aria-label="${title}"]`)!;
        await act(async () =>
          [...section.querySelectorAll<HTMLButtonElement>("button")]
            .find((node) => node.textContent === "Load more dependencies")!
            .click(),
        );
        expect(section.querySelectorAll("a")).toHaveLength(51);
        expect(section.textContent).toContain("tail");
      }
    }
    if (kind === "unmounted") {
      await act(async () => button("History").click());
      await act(async () => {
        await executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.history({ environmentId, input: nativeRef }),
        );
      });
    }
    const before = state.read.mock.calls.length;
    state.newer = true;
    state.failedDependencies = kind === "failed-refresh";
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh issue"]')!.click(),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    expect(container.textContent).toContain("New issue");
    const reads = state.read.mock.calls
      .slice(before)
      .filter(([tag]) => tag === WS_METHODS.issuesDependencies);
    if (!supported || kind === "unmounted") {
      expect(reads).toEqual([]);
    } else {
      expect(reads.map(([, input]) => input)).toEqual(
        expect.arrayContaining(
          (["blocks", "blocked-by"] as const).map((direction) => ({
            ...nativeRef,
            direction,
            limit: 100,
          })),
        ),
      );
      expect(reads).toHaveLength(2);
      for (const [title, direction] of [
        ["Blocks", "blocks"],
        ["Blocked by", "blocked-by"],
      ]) {
        const section = container.querySelector(`[aria-label="${title}"]`)!;
        expect(section.textContent).not.toContain("tail");
        if (kind === "failed-refresh") {
          expect(section.textContent).toContain("Retry dependencies");
          expect(section.textContent).not.toContain("Load more dependencies");
          expect(section.textContent).not.toContain(`New ${direction}`);
          state.failedDependencies = false;
          await act(async () =>
            [...section.querySelectorAll<HTMLButtonElement>("button")]
              .find((node) => node.textContent === "Retry dependencies")!
              .click(),
          );
          expect(section.querySelectorAll("a")).toHaveLength(50);
          expect(section.textContent).toContain(`New ${direction} 1`);
          expect(section.textContent).not.toContain("tail");
          state.failedDependencies = true;
        } else {
          expect(section.querySelectorAll("a")).toHaveLength(50);
          expect(section.textContent).toContain(`New ${direction} 1`);
          expect(section.textContent).not.toContain(`Old ${direction}`);
          await act(async () =>
            [...section.querySelectorAll<HTMLButtonElement>("button")]
              .find((node) => node.textContent === "Load more dependencies")!
              .click(),
          );
          expect(section.querySelectorAll("a")).toHaveLength(51);
          expect(section.textContent).toContain(`New ${direction} tail`);
        }
      }
    }
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "uses updateParent permission instead of edit and keeps native external task links (%s)",
  async (updateParent) => {
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssueNoun: "Tasks",
            updateParent: true,
          },
          viewerPermissions: { ...issue.viewerPermissions, edit: !updateParent, updateParent },
        });
      if (tag === WS_METHODS.issuesHierarchy)
        return decodeHierarchy({
          parent: null,
          children: {
            items: [
              {
                scope: "native/repo",
                key: "9",
                displayKey: "#9",
                title: "Native task",
                itemType: "task",
                externalOnly: true,
                url: "https://gitlab.example/native/repo/-/work_items/9",
                state: { category: "open", name: "open" },
              },
            ],
            nextCursor: null,
          },
        });
      throw new Error("Unexpected RPC " + tag);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={reference} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.hierarchy({ environmentId, input: reference }),
      );
    });
    expect(button("Set parent") !== undefined).toBe(updateParent);
    const hierarchy = container.querySelector('[aria-label="Hierarchy"]')!;
    expect(hierarchy.textContent).toContain("Tasks");
    expect(hierarchy.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://gitlab.example/native/repo/-/work_items/9",
    );
    expect(
      [...hierarchy.querySelectorAll("button")].some((node) =>
        node.textContent?.includes("Native task"),
      ),
    ).toBe(false);
    if (updateParent) {
      await act(async () => button("Set parent").click());
      const input = container.querySelector<HTMLInputElement>('[aria-label="Parent issue key"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "7");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      updateParent = false;
      await act(async () => {
        appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: reference }));
      });
      expect(button("Save").disabled).toBe(true);
      await act(async () => button("Save").click());
    }
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it.each(["success", "permission"])(
  "writes dependency add/remove with the selected account and current permissions (%s)",
  async (kind) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    let writable = true;
    const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssues: false,
            dependencies: true,
          },
          viewerPermissions: { ...issue.viewerPermissions, edit: writable },
        });
      if (tag === WS_METHODS.issuesDependencies)
        return decodeDependencies({
          items: [
            {
              scope: "native/repo",
              key: "2",
              displayKey: "#2",
              title: "Native dependency",
              kind: "issue",
              url: "https://native.example/issues/2",
              state: { category: "open", name: "open" },
            },
          ],
          nextCursor: null,
        });
      throw new Error("Unexpected RPC " + tag);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
      await Promise.all(
        (["blocks", "blocked-by"] as const).map((direction) =>
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.dependencies({
              environmentId,
              input: { ...nativeRef, direction, limit: 100 },
            }),
          ),
        ),
      );
    });
    const blocks = container.querySelector('[aria-label="Blocks"]')!;
    await act(async () =>
      [...blocks.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => node.textContent === "Add dependency")!
        .click(),
    );
    const scope = document.querySelector<HTMLInputElement>("#dependency-scope-blocks")!;
    const key = document.querySelector<HTMLInputElement>("#dependency-key-blocks")!;
    await act(async () => {
      for (const [field, value] of [
        [scope, "target/repo"],
        [key, "7"],
      ] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const add = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (node) => node.textContent === "Add dependency",
      )!;
    if (kind === "permission") {
      writable = false;
      await act(async () => {
        appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: nativeRef }));
      });
      expect(add().disabled).toBe(true);
      await act(async () => add().click());
      expect(state.writes).not.toHaveBeenCalled();
      return;
    }
    await act(async () => add().click());
    expect(state.writes.mock.calls[0]).toEqual([
      WS_METHODS.issuesSetDependency,
      {
        ...nativeRef,
        direction: "blocks",
        targetScope: "target/repo",
        targetKey: "7",
        linked: true,
      },
    ]);
    await act(async () =>
      blocks.querySelector<HTMLButtonElement>('[aria-label="Remove dependency #2"]')!.click(),
    );
    expect(state.writes.mock.calls[1]).toEqual([
      WS_METHODS.issuesSetDependency,
      {
        ...nativeRef,
        direction: "blocks",
        targetScope: "native/repo",
        targetKey: "2",
        linked: false,
      },
    ]);
  },
);
