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
  };
});
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project", issues: [state.linked] }),
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { list: () => null, listPage: "page", resolveUrl: "resolve" },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { linkIssue: "link" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "page" ? state.load : state.link),
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
