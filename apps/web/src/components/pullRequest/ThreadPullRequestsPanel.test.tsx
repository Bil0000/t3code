import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadPullRequestsPanel } from "./ThreadPullRequestsPanel";

const { shell, capabilities, update, openIssue, openInBrowser } = vi.hoisted(() => ({
  shell: vi.fn(),
  capabilities: vi.fn(() => ({ threadPullRequests: true, issues: true })),
  update: vi.fn(async () => ({ _tag: "Success" })),
  openIssue: vi.fn(),
  openInBrowser: vi.fn(),
}));
const project = (id: string, environmentId: string, host: string, repository: string) => ({
  id,
  environmentId,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: `${host}/${repository.toLowerCase()}`,
    displayName: repository,
  },
});
vi.mock("~/state/entities", () => ({
  useThreadShell: shell,
  useProjects: () => [
    project("project-1", "remote", "github.com", "acme/app"),
    project("project-2", "remote", "github.com", "Acme/Api"),
    project("elsewhere", "local", "github.acme.test", "acme/app"),
  ],
  useServerConfigs: () => new Map([["remote", { environment: { capabilities: capabilities() } }]]),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => update }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openIssue }) } }));
vi.mock("~/lib/openIssueLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/openIssueLink")>()),
  openLinkInBrowser: openInBrowser,
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  shouldOpenPullRequestExternally: () => false,
  useOpenPrLink: () => vi.fn(),
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuItem: "button",
  MenuPopup: "div",
  MenuTrigger: () => null,
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/middle-truncate", () => ({ MiddleTruncate: () => null }));
const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const issue = {
  provider: "github",
  repository: "acme/app",
  number: 12,
  title: "Fix refresh",
  url: "https://github.com/acme/app/issues/12",
};
const otherProject = {
  ...issue,
  repository: "acme/api",
  number: 3,
  url: "https://github.com/acme/api/issues/3",
};
const enterprise = { ...issue, url: "https://github.acme.test/acme/app/issues/12" };
const linear = {
  ...issue,
  provider: "linear",
  repository: "ENG",
  url: "https://linear.app/acme/issue/ENG-12",
};
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
  capabilities.mockReturnValue({ threadPullRequests: true, issues: true });
});

async function render(issues: ReadonlyArray<typeof issue & { projectId?: string }>) {
  shell.mockReturnValue({ projectId: "project-1", pullRequests: [], issues });
  await act(() => {
    renderer = create(<ThreadPullRequestsPanel threadRef={ref} />);
  });
}

async function click(url: string) {
  const link = renderer.root.find((node) => node.type === "a" && node.props.href === url);
  await act(() => link.props.onClick({ preventDefault: vi.fn() }));
}

it("opens each issue in the project its URL names, and Linear in the thread's project", async () => {
  await render([issue, otherProject, linear]);
  await click(otherProject.url);
  await click(linear.url);
  expect(openIssue.mock.calls).toEqual([
    [
      ref,
      {
        projectId: "project-2",
        provider: "github",
        repository: "acme/api",
        number: 3,
      },
    ],
    [
      ref,
      {
        projectId: "project-1",
        provider: "linear",
        repository: "ENG",
        number: 12,
      },
    ],
  ]);
  expect(openInBrowser).not.toHaveBeenCalled();
});

it("explains that both kinds of linked items are unavailable", async () => {
  capabilities.mockReturnValue({ threadPullRequests: false, issues: false });
  await render([]);
  expect(
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .some((node) =>
        node.children.includes("This environment does not support linked pull requests or issues."),
      ),
  ).toBe(true);
});

it("keeps the saved source project for Linear", async () => {
  await render([{ ...linear, projectId: "project-2" }]);
  await click(linear.url);
  expect(openIssue).toHaveBeenCalledWith(ref, {
    projectId: "project-2",
    provider: "linear",
    repository: "ENG",
    number: 12,
  });
});

it("opens a link with a missing source project in the browser", async () => {
  await render([{ ...linear, projectId: "missing" }]);
  await click(linear.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(linear.url);
});

it("opens an issue from a host no project in this environment uses in the browser", async () => {
  await render([enterprise]);
  await click(enterprise.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(enterprise.url);
});

it("lists issues on servers that support issues but not multiple pull requests", async () => {
  capabilities.mockReturnValue({ threadPullRequests: false, issues: true });
  await render([issue]);
  await click(issue.url);
  expect(openIssue).toHaveBeenCalledOnce();
});

it("opens issues in the browser when the server cannot read them", async () => {
  capabilities.mockReturnValue({ threadPullRequests: true, issues: false });
  await render([issue]);
  await click(issue.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(issue.url);
});

it("unlinks an issue by its host identity", async () => {
  await render([issue, enterprise]);
  const unlinkButtons = renderer.root.findAll(
    (node) => node.type === "button" && node.children.includes("Unlink from thread"),
  );
  expect(unlinkButtons).toHaveLength(2);
  await act(() => unlinkButtons[1]!.props.onClick());
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: {
      threadId: "thread-1",
      issueUnlink: { provider: "github", repository: "acme/app", number: 12, url: enterprise.url },
    },
  });
});
