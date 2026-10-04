import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadIssueRows } from "./ThreadIssueLinks";

const { shell, unlink, openIssue } = vi.hoisted(() => ({
  shell: vi.fn(),
  unlink: vi.fn(async () => undefined),
  openIssue: vi.fn(),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: shell }));
vi.mock("~/hooks/useIssueLinking", () => ({ useIssueLinking: () => ({ unlink }) }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openIssue }) } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/menu", () => ({ MenuItem: "button" }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../LinkedItemRow", () => ({
  LINKED_ITEM_ROW_CLASS: "",
  LinkedItemRowLines: ({ title }: { title: string }) => <span>{title}</span>,
  LinkedItemRowActions: ({ children }: { children: unknown }) => children,
}));
const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const issue = {
  provider: "github",
  repository: "acme/app",
  number: 12,
  title: "Fix refresh",
  url: "https://github.com/acme/app/issues/12",
};
let renderer: ReactTestRenderer;
const unlinkButtons = () =>
  renderer.root
    .findAllByType("button")
    .filter((button) => button.children.includes("Unlink from thread"));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
});

it("opens the linked issue as the thread panel's own tab and unlinks by identity", async () => {
  shell.mockReturnValue({ projectId: "project-1", issues: [issue] });
  await act(() => {
    renderer = create(<ThreadIssueRows threadRef={ref} />);
  });
  const buttons = renderer.root.findAllByType("button");
  await act(() =>
    buttons
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes(issue.title)),
      )!
      .props.onClick(),
  );
  expect(openIssue).toHaveBeenCalledWith(ref, {
    projectId: "project-1",
    provider: "github",
    repository: "acme/app",
    number: 12,
  });
  await act(() => unlinkButtons()[0]!.props.onClick());
  expect(unlink).toHaveBeenCalledWith(ref, issue);
});

it("unlinks only the selected host's issue when two hosts share its repository and number", async () => {
  const enterprise = { ...issue, url: "https://github.acme.test/acme/app/issues/12" };
  shell.mockReturnValue({ projectId: "project-1", issues: [issue, enterprise] });
  await act(() => {
    renderer = create(<ThreadIssueRows threadRef={ref} />);
  });
  expect(unlinkButtons()).toHaveLength(2);
  await act(() => unlinkButtons()[1]!.props.onClick());
  expect(unlink).toHaveBeenCalledExactlyOnceWith(ref, enterprise);
});

it("renders nothing for threads from older servers without issue links", async () => {
  shell.mockReturnValue({ projectId: "project-1" });
  await act(() => {
    renderer = create(<ThreadIssueRows threadRef={ref} />);
  });
  expect(renderer.toJSON()).toBeNull();
});
