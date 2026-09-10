import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestListEntry,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { act, type PropsWithChildren, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  multiple: true,
  dispatch: vi.fn(),
  entries: [] as PullRequestListEntry[],
  links: [] as ThreadPullRequestLink[],
  queryError: null as string | null,
}));
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
  useThreadShell: () => ({ projectId: project.id, branch: "feature", pullRequests: state.links }),
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
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { list: vi.fn((input: unknown) => input) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { entries: state.entries, errors: [] },
    error: state.queryError,
    isPending: false,
  }),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled: boolean;
    "aria-label": string;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input type="checkbox" {...props} onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
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
import { pullRequestEnvironment } from "~/state/pullRequests";
import { LinkBranchPullRequestButton } from "./LinkBranchPullRequestButton";
import { LinkPullRequestDialogHost } from "./LinkPullRequestDialog";

let renderer: ReactTestRenderer;

function entry(number: number, headBranch = "feature"): PullRequestListEntry {
  return {
    provider: "github",
    host: "github.com",
    projectId: project.id,
    projectTitle: "Web",
    repository: "acme/web",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    author: null,
    headBranch,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    viewerReviewRequested: false,
    labels: [],
  };
}

async function openPicker(linked = true) {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <LinkBranchPullRequestButton threadRef={threadRef} url={entry(1).url} linked={linked} />
        <LinkPullRequestDialogHost />
      </AppAtomRegistryProvider>,
    );
  });
  expect(pullRequestEnvironment.list).not.toHaveBeenCalled();
  await act(async () => {
    await renderer.root
      .findByType("button")
      .props.onClick({ preventDefault() {}, stopPropagation() {} });
  });
}

async function select(...numbers: number[]) {
  for (const number of numbers) {
    await act(async () => {
      renderer.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"]?.startsWith(`Link #${number} `))!
        .props.onChange({ target: { checked: true } });
    });
  }
}

async function submitSelection() {
  await act(async () => {
    await renderer.root
      .findAllByType("button")
      .find(
        (button) =>
          typeof button.props.children === "string" &&
          /^Link \d+ PRs?$/.test(button.props.children),
      )!
      .props.onClick();
  });
}

beforeEach(() => {
  state.multiple = true;
  state.entries = [];
  state.links = [];
  state.queryError = null;
  vi.mocked(pullRequestEnvironment.list).mockClear();
  state.dispatch.mockReset().mockResolvedValue({ _tag: "Success" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
});

afterEach(async () => {
  await act(async () => {
    renderer?.root
      .findAllByType("button")
      .find((button) => button.props.children === "Cancel")
      ?.props.onClick();
    renderer?.unmount();
  });
  vi.unstubAllGlobals();
});

it("adds a second PR through the dialog without replacing the existing link", async () => {
  state.queryError = "Offline";
  await openPicker();
  expect(state.dispatch).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ placeholder: "Pull request URL or #42" }).props.onChange({
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

it("offers several PRs before the first link and links the selected PRs together", async () => {
  state.entries = [entry(3, "other"), entry(2), entry(1)];
  await openPicker(false);
  expect(pullRequestEnvironment.list).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { projectId: project.id, state: "open", involvement: "authored", limit: 20 },
  });
  expect(
    renderer.root
      .findAllByType("input")
      .filter((input) => input.props.type === "checkbox")
      .map((input) => input.props["aria-label"]),
  ).toEqual(["Link #1 PR 1", "Link #2 PR 2", "Link #3 PR 3"]);
  await select(1, 2, 3);
  await submitSelection();
  expect(
    state.dispatch.mock.calls.map(([command, input]) => [command, input.input.number]),
  ).toEqual([
    [threadEnvironment.linkPullRequest, 1],
    [threadEnvironment.linkPullRequest, 2],
    [threadEnvironment.linkPullRequest, 3],
  ]);
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it("marks an existing link and adds two more without replacing it", async () => {
  state.entries = [entry(1), entry(2), entry(3)];
  state.links = [
    {
      ...entry(1),
      source: "manual",
      linkedAt: "2026-09-10T12:00:00Z",
      snapshot: null,
      stack: null,
    },
  ];
  await openPicker();
  const linked = renderer.root
    .findAllByType("input")
    .find((input) => input.props["aria-label"] === "Link #1 PR 1")!;
  expect(linked.props.checked).toBe(true);
  expect(linked.props.disabled).toBe(true);
  await select(2, 3);
  await submitSelection();
  expect(
    state.dispatch.mock.calls.map(([command, input]) => [command, input.input.number]),
  ).toEqual([
    [threadEnvironment.linkPullRequest, 2],
    [threadEnvironment.linkPullRequest, 3],
  ]);
});

it("keeps successful links and retries only the remaining selection after a failure", async () => {
  state.entries = [entry(1), entry(2), entry(3)];
  state.dispatch
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockRejectedValueOnce(new Error("Connection lost"));
  await openPicker(false);
  await select(1, 2, 3);
  await submitSelection();
  expect(renderer.root.findAllByType("p").some((p) => p.props.children === "Connection lost")).toBe(
    true,
  );
  await submitSelection();
  expect(state.dispatch.mock.calls.map(([, input]) => input.input.number)).toEqual([1, 2, 2, 3]);
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it("keeps direct linking for an older single-link server", async () => {
  state.multiple = false;
  await openPicker(false);
  expect(pullRequestEnvironment.list).not.toHaveBeenCalled();
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(threadEnvironment.updateMetadata, {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      linkedPullRequest: {
        projectId: project.id,
        repository: "acme/web",
        number: 1,
        url: entry(1).url,
      },
    },
  });
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
