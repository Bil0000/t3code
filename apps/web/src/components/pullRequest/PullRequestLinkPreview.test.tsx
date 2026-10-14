import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type PullRequestPreview } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const requests = vi.hoisted(() => [] as string[]);
vi.mock("~/state/pullRequests", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { ProjectId } = await import("@t3tools/contracts");
  const response = {
    projectId: ProjectId.make("project-1"),
    repository: "example/repo",
    number: 42,
    title: "Fast preview",
    url: "https://github.com/example/repo/pull/42",
    author: { login: "alice", name: "Alice", avatarUrl: null },
    state: "open",
    isDraft: true,
    createdAt: "2026-10-14T00:00:00.000Z",
  } satisfies PullRequestPreview;
  const query = Atom.family((kind: string) =>
    Atom.make(() => {
      requests.push(kind);
      return AsyncResult.success(response);
    }).pipe(Atom.setIdleTTL(60_000)),
  );
  return {
    pullRequestEnvironment: { preview: () => query("preview"), detail: () => query("detail") },
  };
});
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div onMouseEnter={() => onOpenChange(true)} onMouseLeave={() => onOpenChange(false)}>
      {children}
    </div>
  ),
  PreviewCardTrigger: ({ render }: { render: ReactNode }) => render,
  PreviewCardPopup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { PullRequestLinkPreview } from "./PullRequestLinkPreview";

afterEach(() => vi.unstubAllGlobals());

it("shows a hover card without loading detail and reuses it when opening the link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.length = 0;
  const registry = AtomRegistry.make();
  const opened = vi.fn(() => true);
  const fallback = vi.fn();
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <PullRequestLinkPreview
            link={<a href="https://github.com/example/repo/pull/42">#42</a>}
            originalUrl="https://github.com/example/repo/pull/42"
            target={{
              environmentId: EnvironmentId.make("env-1"),
              input: {
                projectId: ProjectId.make("project-1"),
                repository: "example/repo",
                number: 42,
              },
            }}
            confirmBeforeOpen
            onOpenPullRequest={opened}
            onOpenFallback={fallback}
          />
        </RegistryContext.Provider>,
      );
    });
    expect(requests).toEqual([]);
    await act(async () => renderer!.root.findAllByType("div")[0]!.props.onMouseEnter());
    expect(renderer!.root.findByType("p").children).toEqual(["Fast preview"]);
    expect(requests).toEqual(["preview"]);
    await act(async () => renderer!.root.findAllByType("div")[0]!.props.onMouseLeave());
    await act(async () => {
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      renderer!.root.findByType("a").props.onClick(event);
    });
    expect(opened).toHaveBeenCalledWith("https://github.com/example/repo/pull/42");
    expect(fallback).not.toHaveBeenCalled();
    expect(requests).toEqual(["preview"]);
  } finally {
    await act(async () => renderer?.unmount());
    registry.dispose();
  }
});
