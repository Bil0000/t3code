import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId, ThreadId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  supported: true,
  resolve: vi.fn(),
  openIssue: vi.fn(),
  openExternal: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "env-a",
      repositoryIdentity: {
        provider: "forgejo",
        canonicalKey: "git.acme.test/team/repo",
        locator: { remoteUrl: "https://git.acme.test:8443/team/repo.git" },
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
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openIssue: state.openIssue }) },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
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

function Hook() {
  const handler = useOpenIssueLink(threadRef);
  useEffect(() => {
    open = handler;
  }, [handler]);
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
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
    expect(state.openIssue).toHaveBeenCalledExactlyOnceWith(threadRef, {
      projectId: target.projectId,
      tracker: target.tracker,
      host: target.host,
      scope: target.scope,
      key: target.key,
      url,
    });
    expect(state.openExternal).not.toHaveBeenCalled();
  });

  it("uses the explicit environment without lending another server's project", async () => {
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42", EnvironmentId.make("env-b"));
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url: "https://linear.app/workspace/issue/ENG-42" },
    });
    expect(state.openIssue.mock.calls[0]?.[1]).toMatchObject({ environmentId: "env-b" });
  });

  it("keeps a rejected or excluded URL usable through the native external-link service", async () => {
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const url = "https://forgejo.not-owned.test/team/repo/issues/42";
    await act(async () => {
      open(event(), url);
    });
    expect(state.resolve).toHaveBeenCalledOnce();
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(state.openIssue).not.toHaveBeenCalled();
  });

  it("does not open an issue before a delayed resolver answer", async () => {
    let resolveResponse!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    state.resolve.mockReturnValue(response);
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42");
    });
    expect(state.openIssue).not.toHaveBeenCalled();
    await act(async () => {
      resolveResponse({ _tag: "Success", value: target });
    });
    expect(state.openIssue).toHaveBeenCalledOnce();
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
