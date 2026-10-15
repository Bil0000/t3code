// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId, ThreadId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  preview: vi.fn(),
  command: vi.fn(),
  configs: new Map(
    ["env-a", "env-b"].map((id) => [
      id,
      {
        availableEditors: [],
        environment: {
          capabilities: { issues: true, pullRequests: true, threadPullRequests: true },
        },
      },
    ]),
  ),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "edit-permission"
      ? true
      : typeof atom === "object" && atom !== null && "configEnvironment" in atom
        ? (state.configs.get(String(atom.configEnvironment)) ?? null)
        : null,
}));
vi.mock("../state/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/server")>();
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      configValueAtom: (configEnvironment: string) => ({ configEnvironment }),
    },
  };
});
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => ({ projectId: "project-env-a" }),
  useThreadShell: () => ({ projectId: "project-env-a" }),
  useProjects: () =>
    ["env-a", "env-b"].map((environmentId) => ({
      id: `project-${environmentId}`,
      environmentId,
      workspaceRoot: "/repo",
      repositoryIdentity: {
        provider: "github",
        owner: "acme",
        name: "repo",
        canonicalKey: "github.com/acme/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/repo.git",
        },
      },
    })),
  useServerConfigs: () => state.configs,
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "env-a" }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
  }),
}));
vi.mock("../state/pullRequests", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/pullRequests")>();
  return {
    ...original,
    pullRequestEnvironment: {
      ...original.pullRequestEnvironment,
      detail: (target: unknown) => {
        state.read(target);
        return null;
      },
    },
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.preview }));
vi.mock("../state/issues", () => ({
  issueEnvironment: {
    resolveUrl: "resolve",
    editComment: { permissionAtom: () => "edit-permission" },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));

import { PullRequestCommentBody } from "../components/pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownContext } from "../components/pullRequest/PullRequestMarkdown";
import { IssueCommentContent } from "../components/issue/IssueConversation";
import ChatMarkdown from "../components/ChatMarkdown";
import {
  PULL_REQUESTS_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";

const threadRef = { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make("thread") };
const url = "https://github.com/acme/repo/pull/42";
let container: HTMLDivElement;
let root: Root;
const surfaces = (threaded = true) =>
  selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threaded ? threadRef : PULL_REQUESTS_PANEL_REF,
  ).surfaces;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.configs.get("env-b")!.environment.capabilities.pullRequests = true;
  state.preview.mockResolvedValue({ _tag: "Success", value: { url } });
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show(surface: string, text = `[PR 42](${url})`) {
  const environmentId = EnvironmentId.make(
    surface === "same-environment" || surface === "raw-chat" ? "env-a" : "env-b",
  );
  const reference = {
    projectId: ProjectId.make(`project-${environmentId}`),
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "ENG",
    key: "ENG-7",
    connectionId: "Account/B",
  };
  const owner = surface === "standalone" ? null : threadRef;
  await act(async () =>
    root.render(
      surface === "raw-chat" ? (
        <ChatMarkdown text={text} cwd="/repo" threadRef={threadRef} />
      ) : surface === "comment" || surface === "editor-preview" ? (
        <IssueCommentContent
          environmentId={environmentId}
          reference={reference}
          threadRef={threadRef}
          cwd="/repo"
          canEdit
          comment={{
            id: "comment",
            body: text,
            author: null,
            createdAt: "2026-10-14T00:00:00Z",
            url: null,
            canEdit: true,
          }}
        />
      ) : (
        <PullRequestMarkdownContext
          value={{ repositoryUrl: "https://github.com/acme/repo", threadRef: owner }}
        >
          <PullRequestCommentBody
            text={text}
            cwd="/repo"
            environmentId={environmentId}
            threadRef={owner}
            issueLinkContext={{ ...reference, environmentId }}
          />
        </PullRequestMarkdownContext>
      ),
    ),
  );
  if (surface === "editor-preview") {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => node.textContent === "Preview")!
        .click(),
    );
  }
  return environmentId;
}

it.each(["body", "comment", "editor-preview", "same-environment", "standalone", "raw-chat"])(
  "opens PRs from the source environment in %s",
  async (surface) => {
    const environmentId = await show(surface);
    await act(async () => container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!.click());
    expect(surfaces(surface !== "standalone")).toMatchObject([
      { projectId: `project-${environmentId}`, repository: "acme/repo", number: 42 },
    ]);
    const opened = surfaces(surface !== "standalone")[0];
    expect(opened?.kind).toBe("pull-request");
    if (opened?.kind === "pull-request")
      expect(opened.environmentId ?? threadRef.environmentId).toBe(environmentId);
    expect(state.command).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "reads hover preview only from its supported source (supported=%s)",
  async (supported) => {
    vi.useFakeTimers();
    state.configs.get("env-b")!.environment.capabilities.pullRequests = supported;
    await show("body");
    expect(state.read).not.toHaveBeenCalled();
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(400);
    });
    if (supported)
      expect(state.read).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env-b",
        input: {
          projectId: "project-env-b",
          host: "github.com",
          repository: "acme/repo",
          number: 42,
        },
      });
    else expect(state.read).not.toHaveBeenCalled();
    expect(surfaces()).toEqual([]);
    expect(state.command).not.toHaveBeenCalled();
  },
);

it("confirms a reference through the source PR preview before opening it", async () => {
  await show("body", "#42");
  const link = container.querySelector<HTMLAnchorElement>(
    'a[data-pull-request-autolink="reference"]',
  )!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(state.preview).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env-b",
    input: { projectId: "project-env-b", host: "github.com", repository: "acme/repo", number: 42 },
  });
  expect(surfaces()).toMatchObject([
    { projectId: "project-env-b", environmentId: "env-b", number: 42 },
  ]);
  expect(state.command).not.toHaveBeenCalled();
});
