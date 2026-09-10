import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, type PropsWithChildren, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ multiple: true, dispatch: vi.fn() }));
const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const project = {
  id: ProjectId.make("project"),
  environmentId: threadRef.environmentId,
  repositoryIdentity: {
    provider: "github",
    host: "github.com",
    owner: "acme",
    name: "web",
    displayName: "acme/web",
    canonicalKey: "github.com/acme/web",
  },
};
const projects = [project];

vi.mock("~/state/entities", () => ({
  useProjects: () => projects,
  useThreadShell: () => ({ projectId: project.id }),
  useServerConfigs: () =>
    new Map([
      [
        threadRef.environmentId,
        {
          environment: {
            capabilities: { threadPullRequests: state.multiple, threadPullRequestLinking: true },
          },
        },
      ],
    ]),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (input: unknown) => state.dispatch(command, input),
}));
vi.mock("../ui/dialog", () => {
  const content = ({ children }: PropsWithChildren) => children;
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open && children,
    DialogDescription: content,
    DialogFooter: content,
    DialogHeader: content,
    DialogPanel: content,
    DialogPopup: content,
    DialogTitle: content,
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { threadEnvironment } from "~/state/threads";
import { LinkBranchPullRequestButton } from "./LinkBranchPullRequestButton";
import { LinkPullRequestDialogHost } from "./LinkPullRequestDialog";

let renderer: ReactTestRenderer;

beforeEach(() => {
  state.multiple = true;
  state.dispatch.mockReset().mockResolvedValue({ _tag: "Success" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("adds a second PR through the dialog without replacing the existing link", async () => {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <LinkBranchPullRequestButton
          threadRef={threadRef}
          url="https://github.com/acme/web/pull/1"
          linked
        />
        <LinkPullRequestDialogHost />
      </AppAtomRegistryProvider>,
    );
  });
  await act(async () => {
    await renderer.root.findByType("button").props.onClick({
      preventDefault() {},
      stopPropagation() {},
    });
  });
  expect(state.dispatch).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByType("input").props.onChange({
      target: { value: "https://github.com/acme/api/pull/2" },
      currentTarget: { value: "https://github.com/acme/api/pull/2" },
    });
  });
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Link")!
      .props.onClick();
  });
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(threadEnvironment.linkPullRequest, {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      host: "github.com",
      repository: "acme/api",
      number: 2,
      url: "https://github.com/acme/api/pull/2",
      source: "manual",
    },
  });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it("does not offer another link on a server that only supports one", async () => {
  state.multiple = false;
  await act(async () => {
    renderer = create(
      <LinkBranchPullRequestButton
        threadRef={threadRef}
        url="https://github.com/acme/web/pull/1"
        linked
      />,
    );
  });
  expect(renderer.toJSON()).toBeNull();
  expect(state.dispatch).not.toHaveBeenCalled();
});
