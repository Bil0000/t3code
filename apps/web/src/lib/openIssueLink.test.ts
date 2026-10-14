// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  supported: true,
  resolve: vi.fn(),
  openExternal: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [
    {
      environmentId: "env-a",
      repositoryIdentity: {
        provider: "forgejo",
        canonicalKey: "git.acme.test/team/repo",
        locator: { remoteUrl: "https://fake-token@git.acme.test:8443/team/repo.git" },
      },
    },
  ],
  useServerConfigs: () =>
    new Map([
      ["env-a", { environment: { capabilities: { issues: state.supported } } }],
      ["env-b", { environment: { capabilities: { issues: state.supported } } }],
    ]),
  useThreadShell: () => ({ projectId: "project-a" }),
}));
vi.mock("../state/issues", () => ({ issueEnvironment: { resolveUrl: {} } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.resolve }));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
import {
  ISSUES_PANEL_REF,
  PULL_REQUESTS_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { PullRequestCommentBody } from "../components/pullRequest/PullRequestCommentBody";
import { PullRequestMarkdown } from "../components/pullRequest/PullRequestMarkdown";
import { useOpenIssueLink } from "./openIssueLink";

const threadRef = { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make("thread") };
const target = {
  projectId: ProjectId.make("native-project"),
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "workspace/ENG",
  key: "ENG-42",
  writable: true,
};
let renderer: ReactTestRenderer;
let open: ReturnType<typeof useOpenIssueLink>;
let standalone = false;

function Hook() {
  const handler = useOpenIssueLink(
    standalone ? undefined : threadRef,
    standalone ? PULL_REQUESTS_PANEL_REF : undefined,
  );
  useEffect(() => {
    open = handler;
  }, [handler]);
  return null;
}

const surfaces = (ref: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces;

beforeEach(async () => {
  vi.clearAllMocks();
  useRightPanelStore.setState({ byThreadKey: {} });
  standalone = false;
  state.supported = true;
  state.resolve.mockResolvedValue({ _tag: "Success", value: target });
  state.openExternal.mockResolvedValue(undefined);
  await act(async () => {
    renderer = create(createElement(Hook));
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});
const event = (patch = {}) => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("native chat issue links", () => {
  it.each([
    "https://linear.app/workspace/issue/ENG-42/name",
    "https://acme.atlassian.net/browse/ENG-42",
    "https://git.acme.test:8443/team/repo/issues/42",
    "https://dev.azure.com/acme/Project/_workitems/edit/42",
  ])("asks the server once for %s and opens its native identity", async (url) => {
    const click = event();
    await act(async () => {
      expect(open(click, url)).toBe(true);
    });
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { url, projectId: "project-a" },
    });
    expect(surfaces(threadRef)).toMatchObject([
      {
        kind: "issue",
        projectId: target.projectId,
        tracker: target.tracker,
        host: target.host,
        scope: target.scope,
        key: target.key,
        url,
      },
    ]);
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens a thread-less panel link in the issues page's own panel", async () => {
    standalone = true;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      expect(open(event(), url, EnvironmentId.make("env-b"))).toBe(true);
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url },
    });
    expect(surfaces(PULL_REQUESTS_PANEL_REF)).toEqual([]);
    expect(surfaces(ISSUES_PANEL_REF)).toMatchObject([
      {
        kind: "issue",
        environmentId: "env-b",
        projectId: target.projectId,
        tracker: target.tracker,
        host: target.host,
        scope: target.scope,
        key: target.key,
        url,
      },
    ]);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/issues",
      search: {
        who: "all",
        status: "open",
        selectedEnvironmentId: "env-b",
        selectedProjectId: target.projectId,
        selectedHost: target.host,
        tracker: target.tracker,
        scope: target.scope,
        key: target.key,
      },
    });
  });

  it("keeps a thread-less link the server rejects on the external path", async () => {
    standalone = true;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url, EnvironmentId.make("env-b"));
    });
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(surfaces(ISSUES_PANEL_REF)).toEqual([]);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("uses the explicit environment without lending another server's project", async () => {
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42", EnvironmentId.make("env-b"));
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url: "https://linear.app/workspace/issue/ENG-42" },
    });
    expect(surfaces(threadRef)).toMatchObject([{ environmentId: "env-b" }]);
  });

  it("keeps a rejected or excluded URL usable through the native external-link service", async () => {
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const url = "https://forgejo.not-owned.test/team/repo/issues/42";
    await act(async () => {
      open(event(), url);
    });
    expect(state.resolve).toHaveBeenCalledOnce();
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(surfaces(threadRef)).toEqual([]);
  });

  it("does not open an issue before a delayed resolver answer", async () => {
    let resolve!: (value: unknown) => void;
    state.resolve.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42");
    });
    expect(surfaces(threadRef)).toEqual([]);
    await act(async () => {
      resolve({ _tag: "Success", value: target });
    });
    expect(surfaces(threadRef)).toHaveLength(1);
    expect(state.resolve).toHaveBeenCalledOnce();
  });

  it("leaves ordinary documentation links on the existing path without an issue RPC", () => {
    const click = event();
    expect(open(click, "https://linear.app/docs/api")).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey", "altKey", "shiftKey"])("keeps %s clicks native", async (key) => {
    const click = event({ [key]: true });
    await act(async () => {
      expect(open(click, "https://linear.app/workspace/issue/ENG-42")).toBe(false);
    });
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("keeps unsupported environments on the existing external path", async () => {
    state.supported = false;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    const click = event();
    expect(open(click, "https://linear.app/workspace/issue/ENG-42")).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
  });
});

it.each([PullRequestMarkdown, PullRequestCommentBody])(
  "opens an issue link in a standalone %o body on the issues page",
  async (Body) => {
    const url = "https://linear.app/workspace/issue/ENG-42";
    let body!: ReactTestRenderer;
    await act(async () => {
      body = create(
        createElement(Body, {
          text: `[ENG-42](${url})`,
          cwd: "/repo",
          environmentId: EnvironmentId.make("env-b"),
        }),
      );
    });
    const link = body.root.findAll((node) => node.type === "a" && node.props.href === url)[0]!;
    await act(async () => {
      link.props.onClick(event());
    });
    expect(surfaces(ISSUES_PANEL_REF)).toMatchObject([{ environmentId: "env-b", key: "ENG-42" }]);
    expect(surfaces(PULL_REQUESTS_PANEL_REF)).toEqual([]);
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/issues" }));
    await act(async () => body.unmount());
  },
);
