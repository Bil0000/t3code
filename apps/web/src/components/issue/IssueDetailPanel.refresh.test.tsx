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
  read: vi.fn<(tag: string, input: IssueRef & { cursor?: string }) => unknown>(),
  writes: vi.fn(),
  newer: false,
  failedDetail: false,
  failedRelated: false,
}));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  const { IssueOperationError, WS_METHODS } = await import("@t3tools/contracts");
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/rpc")>()),
    request: (tag: string, input: IssueRef & { cursor?: string }) =>
      Effect.gen(function* () {
        const value = yield* Effect.sync(() => state.read(tag, input));
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
