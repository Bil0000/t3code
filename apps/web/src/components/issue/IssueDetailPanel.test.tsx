// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  IssueCommentsPageInput,
} from "@t3tools/contracts";
import type { IssueState, IssueComment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  detail: {
    projectId: "project",
    projectTitle: "Project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    title: "Issue",
    body: "",
    url: "https://github.com/org/repo/issues/1",
    author: null,
    viewer: null as string | null,
    state: { category: "open", name: "open" } as IssueState,
    states: undefined as ReadonlyArray<IssueState> | undefined,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
    comments: [] as ReadonlyArray<IssueComment>,
    commentsCursor: null as string | null,
    events: [],
    linkedPullRequests: [],
    commentCount: 0,
    writable: true,
    viewerPermissions: {
      comment: true,
      edit: false,
      labels: false,
      assignees: false,
      setState: false,
    },
    capabilities: {
      create: false,
      edit: false,
      comment: true,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: true,
      subIssues: false,
      updateParent: false,
      createSubIssue: false,
      editComment: false,
      states: [] as ReadonlyArray<IssueState>,
      closeReasons: [],
    },
  },
  write: vi.fn(),
  candidatesRead: vi.fn(),
  candidates: {
    data: null as { states: ReadonlyArray<IssueState> } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: vi.fn() }),
}));
vi.mock("./IssueHistory", () => ({ IssueHistory: () => null }));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) =>
    atom?.kind === "states"
      ? state.candidates
      : atom === null
        ? { ...state.candidates, data: null, error: null }
        : {
            data: state.detail,
            error: null,
            isPending: false,
            refresh: vi.fn(),
          },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("~/state/issues", async () => {
  const { Atom } = await import("effect/reactivity");
  const command = { permissionAtom: () => Atom.make(true) };
  return {
    issueEnvironment: {
      detail: () => ({ kind: "detail" }),
      candidates: (target: unknown) => {
        state.candidatesRead(target);
        return { kind: "states" };
      },
      comment: command,
      create: command,
      update: command,
      setState: command,
      setParent: command,
      editComment: command,
    },
    useIssueHierarchy: () => ({
      extra: null,
      items: [],
      hasMore: false,
      isPending: false,
      error: null,
      loadMore: vi.fn(),
    }),
    useIssueLinkedPullRequests: () => ({
      items: [],
      hasMore: false,
      isPending: false,
      error: null,
      loadMore: vi.fn(),
    }),
  };
});
import { IssueDetailPanel } from "./IssueDetailPanel";

const encodeCommentPageInput = Schema.encodeSync(IssueCommentsPageInput);
const decodeCommentPageInput = Schema.decodeUnknownSync(IssueCommentsPageInput);

it("can comment after switching from History to an issue without history support", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockResolvedValue({ _tag: "Success" });
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const history = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "History",
    );
    expect(history).toBeDefined();
    await act(async () => history!.click());
    expect(container.querySelector("textarea")).toBeNull();
    state.detail = {
      ...state.detail,
      key: "2",
      capabilities: { ...state.detail.capabilities, events: false },
    };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Add a comment"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "New comment",
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input!
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(state.write).toHaveBeenCalledWith({
      environmentId,
      input: { ...reference, key: "2", body: "New comment" },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("closes a parent edit draft when the issue identity changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockClear();
  state.detail = {
    ...state.detail,
    key: "1",
    capabilities: {
      ...state.detail.capabilities,
      subIssues: true,
      updateParent: true,
      events: false,
    },
    viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const setParent = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Set parent",
      )!;
    await act(async () => setParent().click());
    expect(container.querySelector('input[aria-label="Parent issue key"]')).not.toBeNull();
    state.detail = { ...state.detail, key: "2" };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    expect(container.querySelector('input[aria-label="Parent issue key"]')).toBeNull();
    await act(async () => setParent().click());
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Parent issue key"]')?.value,
    ).toBe("");
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("closes a sub-issue draft instead of moving it to a different parent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockClear();
  state.detail = {
    ...state.detail,
    key: "1",
    capabilities: {
      ...state.detail.capabilities,
      subIssues: true,
      createSubIssue: true,
      events: false,
    },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "New sub-issue",
    )!;
    await act(async () => create.click());
    const title = document.querySelector<HTMLInputElement>("#issue-create-title");
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Child for first parent",
      );
      title!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.detail = { ...state.detail, key: "2", displayKey: "#2" };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    expect(document.querySelector("#issue-create-title")).toBeNull();
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

describe("native issue state controls", () => {
  const environmentId = EnvironmentId.make("environment");
  let container: HTMLDivElement;
  let root: Root;
  const reference = (tracker: string) => ({
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make(tracker),
    host: "native.example",
    scope: "ENG",
    key: tracker === "jira" ? "ENG-1" : "1",
  });
  const render = (tracker: string) =>
    root.render(<IssueDetailPanel environmentId={environmentId} reference={reference(tracker)} />);
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.write.mockClear().mockResolvedValue({ _tag: "Success" });
    state.candidatesRead.mockClear();
    state.candidates = { data: null, error: null, isPending: false, refresh: vi.fn() };
    state.detail = {
      ...state.detail,
      state: { category: "open", name: "open" },
      states: undefined,
      capabilities: {
        ...state.detail.capabilities,
        subIssues: false,
        createSubIssue: false,
        states: [
          { category: "open", name: "open" },
          { category: "closed", name: "closed" },
        ],
      },
      viewerPermissions: { ...state.detail.viewerPermissions, setState: true },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it.each(["linear", "azure-devops"])(
    "writes native detail IDs with generic capability states (%s)",
    async (tracker) => {
      state.detail = {
        ...state.detail,
        tracker,
        state: { category: "open", name: "Todo", id: "todo-id" },
        states: [
          { category: "open", name: "Todo", id: "todo-id" },
          { category: "open", name: "In Review", id: "review-id" },
        ],
      };
      await act(async () => render(tracker));
      const review = buttons().find((button) => button.textContent === "In Review");
      expect(review).toBeDefined();
      await act(async () => review!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference(tracker), state: "review-id" },
      });
      expect(state.candidatesRead).not.toHaveBeenCalled();
    },
  );
  it("reads Jira states only on menu open and retries failure without generic writes", async () => {
    state.candidates.error = "Project states unavailable";
    state.detail = {
      ...state.detail,
      tracker: "jira",
      state: { category: "open", name: "Todo", id: "todo-id" },
      states: [{ category: "open", name: "Todo", id: "todo-id" }],
    };
    await act(async () => render("jira"));
    expect(state.candidatesRead).not.toHaveBeenCalled();
    const trigger = buttons().find((button) => button.textContent?.startsWith("Change state"))!;
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(state.candidatesRead).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId: reference("jira").projectId,
        tracker: "jira",
        host: "native.example",
        scope: "ENG",
      },
    });
    expect(document.body.textContent).toContain("Project states unavailable");
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(
      items().some((item) => item.textContent === "Close" || item.textContent === "Reopen"),
    ).toBe(false);
    await act(async () =>
      items()
        .find((item) => item.textContent === "Retry")!
        .click(),
    );
    expect(state.candidates.refresh).toHaveBeenCalledOnce();
    expect(state.write).not.toHaveBeenCalled();
    state.candidates = {
      ...state.candidates,
      error: null,
      data: {
        states: [
          { category: "open", name: "Todo", id: "todo-id" },
          { category: "open", name: "In Review", id: "review-id" },
          { category: "closed", name: "Done", id: "done-id" },
        ],
      },
    };
    await act(async () => render("jira"));
    expect(items().map((item) => item.textContent)).toEqual(["In Review", "Done"]);
    await act(async () =>
      items()
        .find((item) => item.textContent === "In Review")!
        .click(),
    );
    expect(state.write).toHaveBeenCalledWith({
      environmentId,
      input: { ...reference("jira"), state: "review-id" },
    });
  });
  it.each(["github", "gitlab"])(
    "keeps generic state writes and capability guards (%s)",
    async (tracker) => {
      state.detail = { ...state.detail, tracker };
      const close = () => buttons().find((button) => button.textContent === "Close");
      await act(async () => render(tracker));
      await act(async () => close()!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference(tracker), state: "closed" },
      });
      state.detail = {
        ...state.detail,
        viewerPermissions: { ...state.detail.viewerPermissions, setState: false },
      };
      await act(async () => render(tracker));
      expect(close()).toBeUndefined();
      state.detail = {
        ...state.detail,
        capabilities: { ...state.detail.capabilities, states: [] },
        viewerPermissions: { ...state.detail.viewerPermissions, setState: true },
      };
      await act(async () => render(tracker));
      expect(close()).toBeUndefined();
      expect(state.candidatesRead).not.toHaveBeenCalled();
      expect(state.write).toHaveBeenCalledOnce();
    },
  );
});

it.each([
  { tracker: "linear", viewer: "viewer-123" },
  { tracker: "jira", viewer: "viewer-123" },
  { tracker: "linear", viewer: null },
])("roundtrips cached viewer context for older comments (%j)", async ({ tracker, viewer }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockReset().mockImplementation(async ({ input }) => {
    const wire = encodeCommentPageInput(input);
    const decoded = decodeCommentPageInput(wire);
    const owned = decoded.viewer === "viewer-123";
    expect(decoded.viewer).toBe(state.detail.viewer ?? undefined);
    return {
      _tag: "Success",
      value: {
        comments: [
          {
            id: "older-own-comment",
            author: { id: "viewer-123", login: "me", name: null, avatarUrl: null },
            body: "Older own comment",
            createdAt: "2026-10-01T00:00:00Z",
            url: null,
            canEdit: owned,
            reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: owned }],
          },
        ],
        nextCursor: null,
      },
    };
  });
  state.detail = {
    ...state.detail,
    tracker,
    key: "ENG-1",
    viewer,
    comments: [],
    commentsCursor: "older",
    capabilities: {
      ...state.detail.capabilities,
      editComment: true,
      reactions: tracker === "linear",
      subIssues: false,
      events: false,
    },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make(tracker),
    host: "native.example",
    scope: "ENG",
    key: "ENG-1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const load = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load older comments",
    )!;
    await act(async () => load.click());
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledWith({
      environmentId,
      input: { ...reference, cursor: "older", viewer: viewer ?? undefined },
    });
    expect(container.textContent).toContain("Older own comment");
    const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]');
    expect(edit !== null).toBe(viewer !== null);
    if (tracker === "linear")
      expect(
        container.querySelector('button[aria-label^="thumbs up,"]')!.getAttribute("aria-pressed"),
      ).toBe(String(viewer !== null));
    if (edit !== null) {
      await act(async () => edit.click());
      expect(
        container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')?.value,
      ).toBe("Older own comment");
    }
    state.detail = { ...state.detail };
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    expect(state.write).toHaveBeenCalledOnce();
    if (viewer !== null) {
      state.detail = { ...state.detail, viewer: "viewer-456" };
      await act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
      expect(container.querySelector('textarea[aria-label="Edit comment"]')).toBeNull();
      expect(container.querySelector('button[aria-label^="thumbs up,"]')).toBeNull();
      expect(state.write).toHaveBeenCalledOnce();
      const reload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load older comments",
      )!;
      await act(async () => reload.click());
      expect(state.write).toHaveBeenCalledTimes(2);
      expect(state.write.mock.calls[1]![0].input.viewer).toBe("viewer-456");
      expect(container.querySelector('button[aria-label="Edit comment"]')).toBeNull();
      if (tracker === "linear")
        expect(
          container.querySelector('button[aria-label^="thumbs up,"]')!.getAttribute("aria-pressed"),
        ).toBe("false");
    } else expect(container.textContent).toContain("Older own comment");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
