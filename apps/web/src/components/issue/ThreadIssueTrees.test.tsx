import type { EnvironmentId, ThreadIssueLink } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadIssueTrees } from "./ThreadIssueTrees";

vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { detail: ({ input }: { input: unknown }) => input, invalidate: null },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: ({ projectId }: { projectId: string }) => ({
    data: issues.find((issue) => issue.projectId === projectId),
    isPending: false,
    refresh: () => {},
  }),
}));

const issue = {
  provider: "github",
  repository: "acme/web",
  number: 7,
  title: "Public",
  url: "https://github.com/acme/web/issues/7",
  state: "open",
  projectId: "public",
} as ThreadIssueLink;
const issues = [
  issue,
  {
    ...issue,
    title: "Enterprise",
    url: "https://github.acme.test/acme/web/issues/7",
    projectId: "enterprise",
  },
] as Array<ThreadIssueLink>;

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
});

it("keeps same-numbered issues on different hosts as separate trees with their own actions", async () => {
  await act(() => {
    renderer = create(
      <ThreadIssueTrees
        environmentId={"env" as EnvironmentId}
        threadRef={null}
        linked={issues}
        projectFor={(linked) => linked.projectId ?? null}
        onOpen={() => {}}
        onOpenPullRequest={() => {}}
        renderActions={(linked) => <span data-url={linked.url} />}
      />,
    );
  });
  expect(
    renderer.root
      .findAll((node) => node.props.role === "tree")
      .map((node) => node.props["aria-label"]),
  ).toEqual(["Public", "Enterprise"]);
  expect(
    renderer.root
      .findAll((node) => node.type === "span" && node.props["data-url"])
      .map((node) => node.props["data-url"]),
  ).toEqual(issues.map((linked) => linked.url));
});
