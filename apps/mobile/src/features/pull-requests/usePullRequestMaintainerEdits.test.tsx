import { RegistryContext } from "@effect/atom-react";
import { canEditPullRequestChangeRequest } from "@t3tools/client-runtime/pull-request-editing";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  connected: true,
  update: vi.fn(),
  permission: undefined as unknown as Atom.Writable<boolean>,
  detail: undefined as unknown as Atom.Writable<null>,
}));
vi.mock("../../state/pull-requests", () => {
  const command = { permissionAtom: () => mocks.permission };
  return {
    composerPullRequests: {
      runAction: command,
      comment: command,
      submitReview: command,
      replyToThread: command,
      setThreadResolution: command,
      update: command,
      updateComment: command,
      setReaction: command,
      detail: () => mocks.detail,
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    {
      environmentId: "environment",
      connectionState: mocks.connected ? "connected" : "offline",
    },
  ],
}));

import { usePullRequestMaintainerEdits } from "./usePullRequestMaintainerEdits";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.connected = true;
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.permission = Atom.make(true);
  mocks.detail = Atom.make(null);
  const registry = AtomRegistry.make();
  const detail: PullRequestDetail = {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    workspaceRoot: "/repo",
    repository: "owner/repo",
    number: 7,
    title: "A change",
    body: "",
    url: "https://github.com/owner/repo/pull/7",
    author: { login: "author", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headBranch: "feature",
    baseBranch: "main",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: false, squash: false, rebase: false },
    capabilities: {
      diff: true,
      comment: true,
      search: true,
      actions: [],
      mergeMethods: [],
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: true, comment: true, maintainerEdits: true },
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
      maintainerEdits: true,
    },
    maintainerCanModify: false,
  };
  const root = createRoot(document.createElement("div"));
  let current!: ReturnType<typeof usePullRequestMaintainerEdits>;
  function Probe() {
    const result = usePullRequestMaintainerEdits(
      {
        environmentId: "environment",
        projectId: "project",
        repository: "owner/repo",
        number: 7,
      },
      detail,
    );
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
  render();
  return {
    detail,
    render,
    registry,
    get current() {
      return current;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("saves an explicit maintainer grant without a viewer login, while honoring local access", async () => {
  using screen = setup();
  expect(canEditPullRequestChangeRequest(screen.detail)).toBe(false);
  expect(screen.current.visible).toBe(true);
  expect(screen.current.disabled).toBe(false);
  await act(async () => screen.current.toggle());
  expect(screen.current.value).toBe(true);
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: EnvironmentId.make("environment"),
    input: {
      projectId: ProjectId.make("project"),
      repository: "owner/repo",
      number: 7,
      maintainerCanModify: true,
    },
  });
  act(() => screen.registry.set(mocks.permission, false));
  expect(screen.current.disabled).toBe(true);
  await act(async () => screen.current.toggle());
  act(() => screen.registry.set(mocks.permission, true));
  mocks.connected = false;
  screen.render();
  expect(screen.current.disabled).toBe(true);
  await act(async () => screen.current.toggle());
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
