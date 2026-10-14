// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type IssueListCursors } from "@t3tools/contracts";

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
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    list: () => null,
    detail: () => null,
    listPage: "page",
    resolveUrl: "resolve",
  },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { linkIssue: "link" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "page" ? state.load : command === "resolve" ? state.resolve : state.link,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: () => state.read(),
}));
vi.mock("~/state/query", () => ({
  formatEnvironmentQueryError: () => "failed",
  useEnvironmentQuery: () => ({
    data: state.list,
    isPending: false,
    error: null,
  }),
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { LinkThreadIssueDialogHost, openLinkThreadIssueDialog } from "./LinkThreadIssueDialog";

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
