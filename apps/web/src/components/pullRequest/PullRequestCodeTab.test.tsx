import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { query, command, refresh } = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: query }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => command }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { diff: (request: unknown) => request },
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => refresh }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({ diffLayout: "unified", diffFilesCollapsed: false, wordWrap: false }),
  useUpdateClientSettings: () => command,
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initial: unknown) => [initial, command],
}));
vi.mock("../diffs/EditableDiffCodeView", () => ({
  EditableDiffCodeView: ({ renderCodeViewFooter }: { renderCodeViewFooter: () => ReactNode }) =>
    renderCodeViewFooter(),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: ReactNode }) => children,
  Toggle: ({
    pressed,
    onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => <button {...props} onClick={() => onPressedChange?.(!pressed)} />,
}));

import PullRequestCodeTab from "./PullRequestCodeTab";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("loads guide pages only on request and resumes scroll loading outside the guide", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers = new Set<() => void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      intersect = () => this.callback([{ isIntersecting: true }]);
      observe() {
        observers.add(this.intersect);
      }
      disconnect() {
        observers.delete(this.intersect);
      }
    },
  );
  const pages = ["one.ts", "two.ts", "three.ts"].map((path, index) => ({
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor: index === 2 ? null : String(index + 1),
    omittedFileStats: [],
  }));
  query.mockImplementation(({ input }: { input: { cursor?: string } }) => ({
    data: pages[Number(input.cursor ?? 0)],
    error: null,
    isPending: false,
    refresh,
  }));
  const detail = {
    body: "",
    number: 1,
    updatedAt: "2026-09-13",
    commits: [],
    reviewThreads: [],
    capabilities: { review: { inlineComment: false, reply: false, resolve: false, verdicts: [] } },
    viewerPermissions: { comment: false, resolve: false, verdicts: [] },
  } as unknown as PullRequestDetailView;
  await act(async () => {
    renderer = create(
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={detail}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />,
      { createNodeMock: () => ({}) },
    );
  });
  const click = async (label: string) => {
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.props["aria-label"] === label)!
        .props.onClick(),
    );
  };
  expect(observers.size).toBe(1);
  await click("Guided review");
  await act(async () => {
    for (const intersect of observers) intersect();
  });
  expect(query.mock.calls.every(([request]) => request.input.cursor === undefined)).toBe(true);
  await click("Load more review files");
  expect(query.mock.lastCall?.[0].input.cursor).toBe("1");
  expect(observers.size).toBe(0);
  await click("Next review file");
  expect(renderer.root.findByType("h2").children).toEqual(["two.ts"]);
  await click("Guided review");
  await act(async () => {
    for (const intersect of observers) intersect();
  });
  expect(query.mock.lastCall?.[0].input.cursor).toBe("2");
});
