// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueListResult,
  ThreadId,
  WS_METHODS,
  type IssueListCursors,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

const state = vi.hoisted(() => {
  const source = {
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    projectTitle: "Project",
    capabilities: { search: true },
  };
  const linked = {
    ...source,
    key: "1",
    displayKey: "#1",
    title: "Already linked",
    url: "https://github.com/org/repo/issues/1",
    state: { category: "open", name: "open" },
  };
  return {
    source,
    linked,
    list: {
      entries: [linked],
      viewers: {} as Record<string, string>,
      trackers: [],
      sources: [source],
      nextCursors: { "github.com org/repo": "next" } as IssueListCursors,
      errors: [],
    },
    load: vi.fn(),
    link: vi.fn(),
    read: vi.fn(),
    resolve: vi.fn(),
  };
});
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project", issues: [state.linked] }),
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const queries = Atom.family((answer: typeof state.list) =>
    Atom.make(AsyncResult.success(answer)).pipe(Atom.keepAlive),
  );
  return {
    issueEnvironment: {
      list: () => queries(state.list),
      detail: () => null,
      listPage: "page",
      resolveUrl: "resolve",
    },
  };
});
vi.mock("~/state/threads", () => ({ threadEnvironment: { linkIssue: "link" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "page" ? state.load : command === "resolve" ? state.resolve : state.link,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: () => state.read(),
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  formatEnvironmentQueryError: () => "failed",
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { LinkThreadIssueDialogHost, openLinkThreadIssueDialog } from "./LinkThreadIssueDialog";

const decodeIssueList = Schema.decodeUnknownSync(IssueListResult);
const RpcClient = await vi.importActual<typeof import("@t3tools/client-runtime/rpc")>(
  "../../../../../packages/client-runtime/src/rpc/client.ts",
);

it.each([false, true])(
  "shows native first-page errors and refreshes only on Retry, with rows: %s",
  async (withRows) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        }),
      ),
    );
    const atoms = createIssueEnvironmentAtoms(runtime);
    const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
    const capabilities = {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    };
    const candidate = {
      ...state.linked,
      key: "2",
      displayKey: "#2",
      title: "Recovered native issue",
      author: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      labels: [],
      assignees: [],
      commentCount: 0,
    };
    const failure = {
      entries: withRows ? [candidate] : [],
      sources: [{ ...state.source, capabilities }],
      trackers: [],
      viewers: { "github github.com": "A" },
      nextCursors: withRows ? { "github github.com org/repo": "2" } : {},
      errors: [
        {
          projectId: "project",
          projectTitle: "Project",
          tracker: "github",
          host: "github.com",
          message: "Native API rate limit reached",
        },
      ],
    };
    const replies = [failure, { ...failure, entries: [candidate], errors: [] }];
    const request = vi.spyOn(RpcClient, "request");
    request.mockImplementation(((tag: string) =>
      Effect.sync(() => {
        expect(tag).toBe(WS_METHODS.issuesList);
        return decodeIssueList(replies.shift());
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const guarded = vi.spyOn(RpcClient, "requestGuarded");
    const { executeAtomQuery } = await vi.importActual<
      typeof import("@t3tools/client-runtime/state/runtime")
    >("@t3tools/client-runtime/state/runtime");
    const target = {
      environmentId: EnvironmentId.make("error-environment"),
      input: {
        state: "all" as const,
        projectId: state.source.projectId as IssueListResult["entries"][number]["projectId"],
        limit: 50,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      openLinkThreadIssueDialog({
        environmentId: target.environmentId,
        threadId: ThreadId.make("error-thread"),
      });
      await act(async () => {
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        );
        await executeAtomQuery(appAtomRegistry, atoms.list(target));
      });
      expect(document.body.textContent).toContain("Native API rate limit reached");
      expect(document.body.textContent).not.toContain("No issues to link.");
      expect(document.body.textContent?.split("Native API rate limit reached")).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(1);
      const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      if (withRows) expect(document.body.textContent).toContain(candidate.title);
      await act(async () => {
        retry!.click();
        await executeAtomQuery(appAtomRegistry, atoms.list(target));
      });
      expect(document.body.textContent).toContain(candidate.title);
      expect(document.body.textContent).not.toContain("Native API rate limit reached");
      expect(request).toHaveBeenCalledTimes(2);
      expect(guarded).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      appAtomRegistry.reset();
      list.mockRestore();
      request.mockRestore();
      guarded.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it("can load later issues when every issue on the first page is already linked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.load.mockResolvedValue({
    _tag: "Success",
    value: {
      entries: [{ ...state.linked, key: "2", title: "Later issue" }],
      nextCursors: {},
      errors: [],
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    });
    await act(async () =>
      root.render(
        createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
      ),
    );
    const load = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load more",
    );
    expect(load).toBeDefined();
    await act(async () => load!.click());
    expect(state.load).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Later issue");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows a source page failure and retries its qualified cursor without paging another tracker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const github = "github github.com org/repo";
  state.list = {
    ...state.list,
    nextCursors: { [github]: "next", "gitlab github.com org/repo": "other" },
  };
  state.load
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [],
        nextCursors: {},
        errors: [
          {
            projectId: state.source.projectId,
            projectTitle: "Project",
            tracker: "github",
            host: "github.com",
            message: "Provider offline",
          },
        ],
      },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [{ ...state.linked, key: "2", title: "Retried issue" }],
        nextCursors: {},
        errors: [],
      },
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    });
    await act(async () =>
      root.render(
        createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
      ),
    );
    const more = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load more",
      );
    await act(async () => more()!.click());
    expect(document.body.textContent).toContain("Provider offline");
    expect(more()).toBeDefined();
    await act(async () => more()!.click());
    expect(state.load).toHaveBeenCalledTimes(2);
    for (const [request] of state.load.mock.calls)
      expect(request.input.cursors).toEqual({ [github]: "next" });
    expect(document.body.textContent).toContain("Retried issue");
    expect(document.body.textContent).not.toContain("Provider offline");
    expect(more()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  "drops the old account's candidates after a new account page, empty: %s",
  async (empty) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const cursor = "github github.com org/repo";
    const row = (key: string) => ({ ...state.linked, key, title: `Issue ${key}` });
    state.list = {
      ...state.list,
      entries: [row("A-first")],
      viewers: { "github github.com": "A" },
      nextCursors: { [cursor]: "A2" },
    };
    const page = (key: string | null, viewer: string, next: string | null) => ({
      entries: key === null ? [] : [row(key)],
      viewers: { "github github.com": viewer },
      sources: [state.source],
      errors: [],
      nextCursors: next === null ? {} : { [cursor]: next },
    });
    state.load
      .mockReset()
      .mockResolvedValueOnce({ _tag: "Success", value: page("A-tail", "A", "A3") })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: page(empty ? null : "B-tail", "B", empty ? null : "B2"),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          ...page(null, "B", null),
          errors: [
            {
              projectId: state.source.projectId,
              projectTitle: "Project",
              tracker: "github",
              host: "github.com",
              message: "Provider offline",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ _tag: "Success", value: page("B-retried", "B", null) });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const more = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load more",
      );
    const text = () => document.body.textContent ?? "";
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      });
      await act(async () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        ),
      );
      expect(text()).toContain("Issue A-first");
      await act(async () => more()!.click());
      expect(text()).toContain("Issue A-first");
      expect(text()).toContain("Issue A-tail");
      await act(async () => more()!.click());
      expect(text()).not.toContain("Issue A-first");
      expect(text()).not.toContain("Issue A-tail");
      if (empty) {
        expect(text()).toContain("No issues to link.");
        expect(more()).toBeUndefined();
      } else {
        expect(text()).toContain("Issue B-tail");
        await act(async () => more()!.click());
        expect(text()).toContain("Provider offline");
        expect(text()).toContain("Issue B-tail");
        await act(async () => more()!.click());
        expect(text()).toContain("Issue B-tail");
        expect(text()).toContain("Issue B-retried");
        expect(text()).not.toContain("Issue A-first");
        expect(text()).not.toContain("Issue A-tail");
        expect(text()).not.toContain("Provider offline");
        expect(more()).toBeUndefined();
      }
      expect(state.load.mock.calls.map(([request]) => request.input.cursors)).toEqual(
        empty
          ? [{ [cursor]: "A2" }, { [cursor]: "A3" }]
          : [{ [cursor]: "A2" }, { [cursor]: "A3" }, { [cursor]: "B2" }, { [cursor]: "B2" }],
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each(["key", "url", "listed", "unsupported-url"])(
  "reuses detail for a direct link and preserves no-detail URL paths (%s)",
  async (path) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const native = {
      ...state.linked,
      key: "42",
      displayKey: "#42",
      title: "Native detail title",
      url: "https://github.com/org/repo/issues/42",
    };
    state.list = { ...state.list, entries: [native], nextCursors: {} };
    state.read.mockReset().mockResolvedValue({ _tag: "Success", value: native });
    state.link.mockReset().mockResolvedValue({ _tag: "Success" });
    state.resolve.mockReset().mockResolvedValue(
      path === "unsupported-url"
        ? { _tag: "Failure" }
        : {
            _tag: "Success",
            value: {
              projectId: native.projectId,
              tracker: native.tracker,
              host: native.host,
              scope: native.scope,
              key: native.key,
              writable: true,
            },
          },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      });
      await act(async () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        ),
      );
      if (path === "listed") {
        const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Native detail title"),
        )!;
        await act(async () => row.click());
      } else {
        const input = document.querySelector<HTMLInputElement>(
          path === "key" ? 'input[aria-label="Issue key"]' : 'input[aria-label="Issue URL"]',
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            input,
            path === "key" ? "42" : native.url,
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () =>
          input
            .closest("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
      }
      if (path === "unsupported-url") {
        expect(state.link).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("failed");
      } else {
        expect(state.link).toHaveBeenCalledOnce();
        const request = state.link.mock.calls[0]![0];
        expect(request.input).toMatchObject({
          threadId: "thread",
          key: "42",
          url: native.url,
          source: "manual",
        });
        if (path === "key") {
          expect(request.input.snapshot).toMatchObject({
            displayKey: "#42",
            title: native.title,
            state: native.state,
          });
          expect(Number.isNaN(Date.parse(request.input.snapshot.syncedAt))).toBe(false);
        } else expect(request.input.snapshot).toBeUndefined();
      }
      expect(state.read).toHaveBeenCalledTimes(path === "key" ? 1 : 0);
      expect(state.resolve).toHaveBeenCalledTimes(
        path === "url" || path === "unsupported-url" ? 1 : 0,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
