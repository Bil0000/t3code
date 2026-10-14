// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  IssueCommentsPageInput,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type {
  IssueState,
  IssueComment,
  IssueReaction,
  IssueLinkedPullRequestsPage,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
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
    reactions: undefined as ReadonlyArray<IssueReaction> | undefined,
    state: { category: "open", name: "open" } as IssueState,
    states: undefined as ReadonlyArray<IssueState> | undefined,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    closedAt: null,
    labels: [],
    milestone: undefined as string | null | undefined,
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
      closeReasons: [] as ReadonlyArray<string>,
    },
  },
  write: vi.fn(),
  projects: [] as EnvironmentProject[],
  allowed: true,
  toast: vi.fn(),
  candidatesRead: vi.fn(),
  candidates: {
    data: null as { states: ReadonlyArray<IssueState> } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));
vi.mock("~/state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("@t3tools/client-runtime/state/issues", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) =>
    Atom.make(
      AsyncResult.success<IssueLinkedPullRequestsPage>({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/issues")>()),
    createIssueEnvironmentAtoms: () => ({
      linkedPullRequests: (target: unknown) => pages(JSON.stringify(target)),
    }),
  };
});
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: vi.fn() }),
}));
vi.mock("./IssueHistory", () => ({ IssueHistory: () => null }));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
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
vi.mock("~/state/issues", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/state/issues")>();
  const { Atom } = await import("effect/reactivity");
  const command = { permissionAtom: () => Atom.make(state.allowed) };
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
    useIssueLinkedPullRequests: original.useIssueLinkedPullRequests,
  };
});
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { formatRelativeTimeLabel } from "~/timestampFormat";

const encodeCommentPageInput = Schema.encodeSync(IssueCommentsPageInput);
const decodeCommentPageInput = Schema.decodeUnknownSync(IssueCommentsPageInput);

it.each(["success", "comment-failure", "close-failure", "linear", "no-state-permission", "closed"])(
  "posts before closing with a comment and preserves partial success (%s)",
  async (kind) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.toast.mockReset();
    state.candidatesRead.mockReset();
    state.write
      .mockReset()
      .mockImplementation(async ({ input }) =>
        (kind === "comment-failure" && input.body !== undefined) ||
        (kind === "close-failure" && input.state !== undefined)
          ? { _tag: "Failure", cause: Cause.fail(new Error("Native write denied")) }
          : { _tag: "Success" },
      );
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make(kind === "linear" ? "linear" : "github"),
      host: kind === "linear" ? "linear.app" : "github.com",
      scope: "org/repo",
      key: "1",
    };
    const generic = [
      { category: "open" as const, name: "open" },
      { category: "closed" as const, name: "closed" },
    ];
    const states =
      kind === "linear"
        ? [
            { category: "open" as const, name: "Todo", id: "todo" },
            { category: "closed" as const, name: "Done", id: "native-done" },
          ]
        : generic;
    state.detail = {
      ...state.detail,
      ...reference,
      state: kind === "closed" ? generic[1]! : states[0]!,
      states,
      writable: true,
      comments: [],
      commentsCursor: null,
      reactions: undefined,
      viewerPermissions: {
        ...state.detail.viewerPermissions,
        comment: true,
        setState: kind !== "no-state-permission",
      },
      capabilities: {
        ...state.detail.capabilities,
        states: generic,
        closeReasons: ["completed", "not-planned"],
        comment: true,
        events: false,
        linkedPullRequests: false,
      },
    };
    const updated = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={reference}
            onUpdated={updated}
          />,
        ),
      );
      const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Close with comment",
      );
      if (kind === "no-state-permission" || kind === "closed") {
        expect(close).toBeUndefined();
        expect(state.write).not.toHaveBeenCalled();
        return;
      }
      expect(close).toBeDefined();
      expect(close!.disabled).toBe(true);
      const input = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Add a comment"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          input,
          "Keep this comment",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => close!.click());
      expect(state.write.mock.calls[0]![0]).toEqual({
        environmentId,
        input: { ...reference, body: "Keep this comment" },
      });
      if (kind === "comment-failure") {
        expect(state.write).toHaveBeenCalledOnce();
        expect(input.value).toBe("Keep this comment");
        expect(updated).not.toHaveBeenCalled();
      } else {
        expect(state.write).toHaveBeenCalledTimes(2);
        expect(state.write.mock.calls[1]![0]).toEqual({
          environmentId,
          input: {
            ...reference,
            state: kind === "linear" ? "native-done" : "closed",
            ...(kind === "linear" ? {} : { closeReason: "completed" }),
          },
        });
        expect(input.value).toBe("");
        expect(updated).toHaveBeenCalledOnce();
        if (kind === "close-failure")
          expect(state.toast).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "error",
              title: "The comment was posted, but the issue could not be closed",
            }),
          );
        await act(async () => close!.click());
        expect(state.write).toHaveBeenCalledTimes(2);
      }
      expect(state.candidatesRead).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

it.each(["none", "matched", "foreign-repository", "other-environment"])(
  "keeps a Linear linked MR on its supported native destination (%s)",
  async (kind) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("linear-workspace"),
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
    };
    const repository = kind === "foreign-repository" ? "acme/local" : "acme/web";
    state.projects =
      kind === "none"
        ? []
        : [
            {
              environmentId:
                kind === "other-environment" ? EnvironmentId.make("other") : environmentId,
              id: ProjectId.make("gitlab-checkout"),
              title: "GitLab checkout",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-14T00:00:00Z",
              updatedAt: "2026-10-14T00:00:00Z",
              repositoryIdentity: {
                provider: "gitlab",
                canonicalKey: `gitlab.example.com/${repository}`,
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: `https://gitlab.example.com/${repository}.git`,
                },
              },
            },
          ];
    state.detail = {
      ...state.detail,
      ...reference,
      comments: [],
      commentsCursor: null,
      reactions: undefined,
      capabilities: {
        ...state.detail.capabilities,
        states: [],
        linkedPullRequests: true,
        events: false,
      },
    };
    const url = "https://gitlab.example.com/acme/web/-/merge_requests/7";
    const { issueEnvironment } =
      await vi.importActual<typeof import("~/state/issues")>("~/state/issues");
    const page = issueEnvironment.linkedPullRequests({
      environmentId,
      input: reference,
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    appAtomRegistry.set(
      page,
      AsyncResult.success({
        items: [
          {
            provider: SourceControlProviderKind.make("gitlab"),
            host: "gitlab.example.com",
            repository: "acme/web",
            number: 7,
            title: "Linked MR",
            url,
            state: "open",
            isDraft: false,
            closesIssue: false,
          },
        ],
        nextCursor: null,
      }),
    );
    const select = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <IssueDetailPanel
              environmentId={environmentId}
              reference={reference}
              onSelectPullRequest={select}
            />
          </RegistryContext.Provider>,
        ),
      );
      if (kind === "matched" || kind === "foreign-repository") {
        const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Linked MR"),
        )!;
        await act(async () => row.click());
        expect(select).toHaveBeenCalledExactlyOnceWith({
          projectId: "gitlab-checkout",
          host: "gitlab.example.com",
          repository: "acme/web",
          number: 7,
          url,
        });
      } else {
        expect(container.querySelector(`a[href="${url}"]`)).not.toBeNull();
        expect(select).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      state.projects = [];
      vi.unstubAllGlobals();
    }
  },
);

it.each(["viewer-a", null])(
  "clears issue and comment reaction confirmation on viewer switch before ACK (%s)",
  async (viewer) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.write.mockReset().mockResolvedValue({ _tag: "Success" });
    const reactions = [
      { content: "thumbs-up" as const, count: 2, actors: [], viewerHasReacted: false },
    ];
    state.detail = {
      ...state.detail,
      viewer,
      reactions,
      writable: true,
      commentsCursor: null,
      comments: [
        {
          id: "comment",
          author: null,
          body: "Native comment",
          createdAt: "2026-10-14T00:00:00Z",
          url: null,
          reactions,
        },
      ],
      capabilities: {
        ...state.detail.capabilities,
        reactions: true,
        events: false,
        linkedPullRequests: false,
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
    const pills = () => [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="thumbs up,"]'),
    ];
    const render = () =>
      act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
    try {
      await render();
      expect(pills()).toHaveLength(2);
      for (const pill of pills()) await act(async () => pill.click());
      expect(pills().map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")])).toEqual([
        ["👍3", "true"],
        ["👍3", "true"],
      ]);
      state.detail = {
        ...state.detail,
        reactions: [...reactions],
        comments: state.detail.comments.map((comment) => ({
          ...comment,
          reactions: [...reactions],
        })),
      };
      await render();
      expect(pills().every((pill) => pill.getAttribute("aria-pressed") === "true")).toBe(true);
      const native = [{ ...reactions[0]!, count: 3 }];
      state.detail = {
        ...state.detail,
        viewer: "viewer-b",
        reactions: native,
        comments: state.detail.comments.map((comment) => ({ ...comment, reactions: native })),
      };
      await render();
      expect(pills().map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")])).toEqual([
        ["👍3", "false"],
        ["👍3", "false"],
      ]);
      for (const pill of pills()) await act(async () => pill.click());
      expect(
        state.write.mock.calls.map(([request]) => [request.input.subjectId, request.input.reacted]),
      ).toEqual([
        [undefined, true],
        ["comment", true],
        [undefined, true],
        ["comment", true],
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["Sprint 4", false],
  [null, false],
  [undefined, false],
  [undefined, true],
] as const)(
  "restores unlinked read-only detail metadata and copying (%s, blocked=%s)",
  async (milestone, blockedCopy) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn();
    if (blockedCopy) writeText.mockRejectedValue(new Error("Clipboard blocked"));
    else writeText.mockResolvedValue(undefined);
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), { clipboard: { writeText } }),
    );
    state.toast.mockReset();
    state.detail = {
      ...state.detail,
      milestone,
      state: { category: "open", name: "Waiting for QA" },
      writable: false,
      comments: [],
      commentsCursor: null,
      capabilities: {
        ...state.detail.capabilities,
        states: [],
        events: false,
        linkedPullRequests: false,
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
      expect(container.textContent).toContain("Waiting for QA");
      expect(container.textContent).toContain(
        `updated ${formatRelativeTimeLabel(state.detail.updatedAt)}`,
      );
      expect(container.textContent?.includes("Milestone")).toBe(
        milestone !== null && milestone !== undefined,
      );
      if (milestone) expect(container.textContent).toContain(milestone);
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy issue link"]')!.click(),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(state.detail.url);
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining(
          blockedCopy
            ? { type: "error", title: "The issue link could not be copied" }
            : { type: "success", title: "Issue link copied", description: state.detail.url },
        ),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

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
        closeReasons: [],
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
  it("closes Jira with a comment only after native state retry and a successful post", async () => {
    state.allowed = true;
    state.candidates.error = "Project states unavailable";
    state.detail = {
      ...state.detail,
      tracker: "jira",
      writable: true,
      state: { category: "open", name: "Todo", id: "todo-id" },
      states: [{ category: "open", name: "Todo", id: "todo-id" }],
      capabilities: { ...state.detail.capabilities, comment: true, closeReasons: ["completed"] },
      viewerPermissions: { ...state.detail.viewerPermissions, comment: true, setState: true },
    };
    let finishPost!: (result: { _tag: "Success" }) => void;
    const posted = new Promise<{ _tag: "Success" }>((resolve) => {
      finishPost = resolve;
    });
    state.write
      .mockReset()
      .mockImplementation(async ({ input }) =>
        input.body === undefined ? { _tag: "Success" } : posted,
      );
    await act(async () => render("jira"));
    expect(state.candidatesRead).not.toHaveBeenCalled();
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Add a comment"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Ready to close",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const trigger = buttons().find((button) => button.textContent === "Close with comment")!;
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
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.body.textContent).toContain("Project states unavailable");
    expect(state.write).not.toHaveBeenCalled();
    expect(input.value).toBe("Ready to close");
    await act(async () =>
      items()
        .find((item) => item.textContent === "Retry")!
        .click(),
    );
    expect(state.candidates.refresh).toHaveBeenCalledOnce();
    state.candidates = {
      ...state.candidates,
      error: null,
      data: {
        states: [
          state.detail.state,
          { category: "closed", name: "Done", id: "10003" },
          { category: "closed", name: "Canceled", id: "10004" },
        ],
      },
    };
    await act(async () => render("jira"));
    expect(items().map((item) => item.textContent)).toEqual(["Done", "Canceled"]);
    await act(async () =>
      items()
        .find((item) => item.textContent === "Done")!
        .click(),
    );
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.write.mock.calls[0]![0]).toEqual({
      environmentId,
      input: { ...reference("jira"), body: "Ready to close" },
    });
    expect(
      buttons().find((button) => button.textContent?.startsWith("Change state"))!.disabled,
    ).toBe(true);
    await act(async () => finishPost({ _tag: "Success" }));
    expect(state.write.mock.calls[1]![0]).toEqual({
      environmentId,
      input: { ...reference("jira"), state: "10003" },
    });
    expect(input.value).toBe("");
  });
  it.each(["linear", "github"])(
    "uses close reasons only for generic closed states (%s)",
    async (tracker) => {
      state.detail = {
        ...state.detail,
        tracker,
        capabilities: {
          ...state.detail.capabilities,
          closeReasons:
            tracker === "linear" ? ["completed", "canceled"] : ["completed", "not_planned"],
        },
      };
      if (tracker === "linear")
        state.detail = {
          ...state.detail,
          state: { category: "open", name: "Todo", id: "todo-id" },
          states: [
            { category: "open", name: "Todo", id: "todo-id" },
            { category: "closed", name: "Done", id: "done-id" },
          ],
        };
      await act(async () => render(tracker));
      const trigger = buttons().find((button) =>
        button.textContent?.startsWith(tracker === "linear" ? "Change state" : "Close"),
      )!;
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent === (tracker === "linear" ? "Done" : "Close as completed"),
      );
      expect(item).toBeDefined();
      await act(async () => item!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: {
          ...reference(tracker),
          state: tracker === "linear" ? "done-id" : "closed",
          ...(tracker === "github" ? { closeReason: "completed" } : {}),
        },
      });
    },
  );
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

it.each(["unknown", "allowed", "denied", "unsupported", "no-grant", "read-only"])(
  "keeps Azure comment editing behind native and client guards (%s)",
  async (guard) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = guard !== "no-grant";
    state.toast.mockReset();
    state.write.mockReset().mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Azure 403 Forbidden")),
    });
    state.detail = {
      ...state.detail,
      tracker: "azure-devops",
      viewer: null,
      key: "42",
      comments: [
        {
          id: "comment",
          author: null,
          body: "Original comment",
          createdAt: "2026-10-14T00:00:00Z",
          url: null,
          ...(guard === "unknown" ? {} : { canEdit: guard !== "denied" }),
        },
      ],
      commentsCursor: null,
      writable: guard !== "read-only",
      capabilities: {
        ...state.detail.capabilities,
        editComment: guard !== "unsupported",
        reactions: false,
        events: false,
      },
    };
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("azure-devops"),
      host: "dev.azure.com",
      scope: "org/project",
      key: "42",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
      const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]');
      expect(edit !== null).toBe(guard === "unknown" || guard === "allowed");
      if (guard === "unknown") {
        await act(async () => edit!.click());
        const input = container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Edit comment"]',
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
            input,
            "Keep this draft",
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Save",
        )!;
        await act(async () => save.click());
        expect(state.write).toHaveBeenCalledExactlyOnceWith({
          environmentId,
          input: { ...reference, commentId: "comment", body: "Keep this draft" },
        });
        expect(state.toast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not save the comment",
            description: "Azure 403 Forbidden",
          }),
        );
        expect(
          container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')
            ?.value,
        ).toBe("Keep this draft");
        expect(save.disabled).toBe(false);
      } else expect(state.write).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.allowed = true;
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  { tracker: "github", cursor: "related:" },
  { tracker: "gitlab", cursor: "related:1" },
])(
  "loads related pull requests after an empty closing page ($tracker)",
  async ({ tracker, cursor }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make(tracker),
      host: `${tracker}.com`,
      scope: "org/repo",
      key: "1",
    };
    state.detail = {
      ...state.detail,
      ...reference,
      comments: [],
      commentsCursor: null,
      capabilities: { ...state.detail.capabilities, linkedPullRequests: true, subIssues: false },
    };
    const { issueEnvironment } =
      await vi.importActual<typeof import("~/state/issues")>("~/state/issues");
    const first = issueEnvironment.linkedPullRequests({
      environmentId,
      input: reference,
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    const next = issueEnvironment.linkedPullRequests({
      environmentId,
      input: { ...reference, cursor },
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    appAtomRegistry.set(first, AsyncResult.success({ items: [], nextCursor: cursor }));
    const url = `https://${tracker}.com/org/repo/pull/2`;
    appAtomRegistry.set(
      next,
      AsyncResult.success({
        items: [
          {
            repository: "org/repo",
            number: 2,
            title: "Related change",
            url,
            state: "open",
            isDraft: false,
            closesIssue: false,
          },
        ],
        nextCursor: null,
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <IssueDetailPanel environmentId={environmentId} reference={reference} />
          </RegistryContext.Provider>,
        ),
      );
      const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load more pull requests",
      );
      expect(loadMore).toBeDefined();
      await act(async () => loadMore!.click());
      expect(container.textContent).toContain("Related change");
      expect(container.querySelector(`a[href="${url}"]`)).not.toBeNull();
      expect(container.textContent).not.toContain("Load more pull requests");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = {
        ...state.detail,
        capabilities: { ...state.detail.capabilities, linkedPullRequests: false },
      };
      vi.unstubAllGlobals();
    }
  },
);
