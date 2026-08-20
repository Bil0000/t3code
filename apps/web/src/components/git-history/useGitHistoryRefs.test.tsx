import { EnvironmentId, type VcsHistoryRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const refState = vi.hoisted(() => ({
  currentRefResolved: true,
  currentRef: null as VcsHistoryRef | null,
  localError: null as string | null,
  debouncedRefFilter: "",
  local: [] as ReadonlyArray<VcsHistoryRef>,
  remote: [] as ReadonlyArray<VcsHistoryRef>,
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  isComplete: true,
  nextCursor: null as string | null,
  refreshLocal: vi.fn(),
  refreshRemote: vi.fn(),
  refreshTags: vi.fn(),
  remoteGeneration: 0,
  remoteRequestKeys: [] as string[],
  targets: [] as Array<{
    readonly target: unknown;
    readonly namespace: string;
    readonly revision: number | undefined;
  }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useDeferredValue: <Value,>(value: Value) => value,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/queries", () => ({
  useDebouncedValue: () => refState.debouncedRefFilter,
  usePaginatedHistoryRefs: (
    _target: unknown,
    options: { readonly namespace: string; readonly revision?: number },
  ) => {
    refState.targets.push({
      target: _target,
      namespace: options.namespace,
      revision: options.revision,
    });
    const refs =
      options.namespace === "local"
        ? refState.local
        : options.namespace === "remote"
          ? refState.remote
          : refState.tags;
    const target = _target as { readonly environmentId: EnvironmentId | null };
    if (options.namespace === "remote" && target.environmentId !== null) {
      refState.remoteRequestKeys.push(`remote:${refState.remoteGeneration}`);
    }
    return {
      data:
        target.environmentId === null ||
        (options.namespace === "local" && !refState.currentRefResolved)
          ? null
          : {
              currentRef: refState.currentRef,
              nextCursor: refState.nextCursor,
              isComplete: refState.isComplete,
            },
      refs,
      error: options.namespace === "local" ? refState.localError : null,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh:
        options.namespace === "local"
          ? refState.refreshLocal
          : options.namespace === "remote"
            ? () => {
                refState.remoteGeneration += 1;
                refState.refreshRemote();
              }
            : refState.refreshTags,
      retry: vi.fn(),
    };
  },
}));

import { GitRefsPane } from "./GitHistoryRefsPane";
import { useGitHistoryRefs } from "./useGitHistoryRefs";

const environmentId = EnvironmentId.make("environment-local");
const repositoryCwd = "C:/workspace";

function ref(name: string, isRemote = false): VcsHistoryRef {
  return { current: false, isDefault: false, isRemote, name, worktreePath: null };
}

function renderRefs(revision = 0) {
  hooks.beginRender();
  const historyRefs = useGitHistoryRefs(environmentId, repositoryCwd, revision);
  const pane = GitRefsPane({
    refFilter: historyRefs.refFilter,
    onRefFilterChange: historyRefs.setRefFilter,
    selectedRevision: historyRefs.selectedRevision ?? null,
    onSelectAll: historyRefs.selectAllRefs,
    currentRef: historyRefs.currentRef ?? null,
    onSelectRef: historyRefs.selectRef,
    normalizedRefFilter: historyRefs.normalizedRefFilter,
    localRefTree: historyRefs.localRefTree,
    remoteRefTree: historyRefs.remoteRefTree,
    tagRefTree: historyRefs.tagRefTree,
    expandedRefKeys: historyRefs.expandedRefKeys,
    onToggleRefKey: historyRefs.toggleRefKey,
    hasMoreRefs: historyRefs.hasMoreRefs,
    isFetchingMoreRefs: historyRefs.isFetchingMoreRefs,
    isRefSnapshotComplete: historyRefs.isRefSnapshotComplete,
    onLoadMoreRefs: historyRefs.onLoadMoreRefs,
    refPaginationError: historyRefs.refPaginationError,
    onRetryRefs: historyRefs.onRetryRefs,
  }) as ReactElement<Record<string, unknown>>;
  const list = visitElements(pane, (element) => typeof element.props.keyExtractor === "function");
  expect(list).not.toBeNull();
  const capStatus = visitElements(pane, (element) => element.props.role === "status");
  return { historyRefs, rows: list!.props.data as ReadonlyArray<unknown>, capStatus };
}

describe("useGitHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    refState.currentRefResolved = true;
    refState.currentRef = null;
    refState.localError = null;
    refState.debouncedRefFilter = "";
    refState.local = [];
    refState.remote = [];
    refState.tags = [];
    refState.isComplete = true;
    refState.nextCursor = null;
    refState.refreshLocal.mockReset();
    refState.refreshRemote.mockReset();
    refState.refreshTags.mockReset();
    refState.remoteGeneration = 0;
    refState.remoteRequestKeys = [];
    refState.targets = [];
  });

  it("preserves ref trees and the 10k-row virtual-list model across unchanged rerenders", () => {
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));

    const collapsed = renderRefs();
    collapsed.historyRefs.toggleRefKey("section:remote");
    const first = renderRefs();
    const second = renderRefs();

    expect(second.historyRefs.localRefs).toBe(first.historyRefs.localRefs);
    expect(second.historyRefs.remoteRefs).toBe(first.historyRefs.remoteRefs);
    expect(second.historyRefs.localRefTree).toBe(first.historyRefs.localRefTree);
    expect(second.historyRefs.remoteRefTree).toBe(first.historyRefs.remoteRefTree);
    expect(second.rows).toBe(first.rows);
    expect(second.rows).toHaveLength(10_005);
  });

  it("states the first-10,000 cap when the server snapshot is incomplete", () => {
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));
    refState.isComplete = false;

    const rendered = renderRefs();

    expect(rendered.capStatus?.props.children).toBe("Showing the first 10,000 matching refs.");
  });

  it("refreshes every ref namespace", () => {
    const rendered = renderRefs();

    rendered.historyRefs.refreshRefs();

    expect(refState.refreshLocal).toHaveBeenCalledOnce();
    expect(refState.refreshRemote).toHaveBeenCalledOnce();
    expect(refState.refreshTags).toHaveBeenCalledOnce();

    rendered.historyRefs.toggleRefKey("section:remote");
    rendered.historyRefs.toggleRefKey("section:tags");
    const expanded = renderRefs();

    expanded.historyRefs.refreshRefs();

    expect(refState.refreshLocal).toHaveBeenCalledTimes(2);
    expect(refState.refreshRemote).toHaveBeenCalledTimes(2);
    expect(refState.refreshTags).toHaveBeenCalledTimes(2);
  });

  it("refreshes a collapsed remote namespace before loading it again", () => {
    const initial = renderRefs();
    initial.historyRefs.toggleRefKey("section:remote");
    const expanded = renderRefs();
    expect(refState.remoteRequestKeys).toEqual(["remote:0"]);

    expanded.historyRefs.toggleRefKey("section:remote");
    const collapsed = renderRefs();
    expect(refState.remoteRequestKeys).toEqual(["remote:0"]);

    collapsed.historyRefs.refreshRefs();
    expect(refState.refreshRemote).toHaveBeenCalledOnce();
    expect(refState.remoteGeneration).toBe(1);

    collapsed.historyRefs.toggleRefKey("section:remote");
    renderRefs();

    expect(refState.remoteRequestKeys).toEqual(["remote:0", "remote:1"]);
  });

  it("keeps the history revision unresolved until the local ref snapshot resolves", () => {
    refState.currentRefResolved = false;

    const rendered = renderRefs();

    expect(rendered.historyRefs.currentRef).toBeUndefined();
    expect(rendered.historyRefs.selectedRevision).toBeUndefined();
  });

  it("falls back to all history when an unresolved local ref request fails after rendering", () => {
    refState.currentRefResolved = false;

    expect(renderRefs().historyRefs.selectedRevision).toBeUndefined();

    refState.localError = "Could not load refs.";

    expect(renderRefs().historyRefs.selectedRevision).toBeNull();
  });

  it("keeps the resolved current branch selected while a ref filter refresh is pending", () => {
    refState.currentRef = ref("main");

    renderRefs();
    refState.currentRefResolved = false;

    expect(renderRefs().historyRefs.selectedRevision).toEqual({
      label: "main",
      revision: "refs/heads/main",
    });
  });

  it("falls back to all history when the initial local ref request fails", () => {
    refState.currentRefResolved = false;
    refState.localError = "Could not load refs.";

    const rendered = renderRefs();

    expect(rendered.historyRefs.selectedRevision).toBeNull();
    expect(rendered.historyRefs.refPaginationError).toBe("Could not load refs.");
  });

  it("keeps the current local branch loaded after collapsing Local", () => {
    refState.currentRef = ref("main");

    const initial = renderRefs();
    initial.historyRefs.toggleRefKey("section:local");
    refState.targets = [];

    const collapsed = renderRefs();

    expect(refState.targets).toContainEqual({
      namespace: "local",
      revision: 0,
      target: { environmentId, cwd: repositoryCwd, query: "" },
    });
    expect(collapsed.historyRefs.currentRef?.name).toBe("main");
    expect(collapsed.historyRefs.selectedRevision).toEqual({
      label: "main",
      revision: "refs/heads/main",
    });
  });

  it("keeps the default selected revision stable across unchanged rerenders", () => {
    refState.currentRef = ref("main");

    const first = renderRefs();
    const second = renderRefs();

    expect(second.historyRefs.selectedRevision).toBe(first.historyRefs.selectedRevision);
  });

  it("falls back to the current branch when a completed snapshot removes the selected local ref", () => {
    refState.currentRef = ref("main");
    refState.local = [ref("main"), ref("feature/renamed")];

    const initial = renderRefs();
    initial.historyRefs.selectRef("feature/renamed", "refs/heads/feature/renamed");
    expect(renderRefs().historyRefs.selectedRevision).toEqual({
      label: "feature/renamed",
      revision: "refs/heads/feature/renamed",
    });

    initial.historyRefs.setRefFilter("main");
    refState.local = [ref("main")];
    refState.debouncedRefFilter = "main";

    expect(renderRefs(1).historyRefs.selectedRevision).toEqual({
      label: "feature/renamed",
      revision: "refs/heads/feature/renamed",
    });

    initial.historyRefs.setRefFilter("");
    refState.debouncedRefFilter = "";
    refState.nextCursor = "cursor-2";

    expect(renderRefs(1).historyRefs.selectedRevision).toEqual({
      label: "feature/renamed",
      revision: "refs/heads/feature/renamed",
    });

    refState.nextCursor = null;

    expect(renderRefs(1).historyRefs.selectedRevision).toEqual({
      label: "main",
      revision: "refs/heads/main",
    });
  });

  it("keeps the selected remote or tag namespace loaded while its section is collapsed", () => {
    const initial = renderRefs();
    initial.historyRefs.selectRef("origin/feature", "refs/remotes/origin/feature");
    refState.targets = [];

    renderRefs();

    expect(refState.targets).toContainEqual({
      namespace: "remote",
      revision: 0,
      target: { environmentId, cwd: repositoryCwd, query: "" },
    });

    initial.historyRefs.selectRef("v1.0.0", "refs/tags/v1.0.0");
    refState.targets = [];

    renderRefs();

    expect(refState.targets).toContainEqual({
      namespace: "tag",
      revision: 0,
      target: { environmentId, cwd: repositoryCwd, query: "" },
    });
  });

  it("passes a repository revision to every history ref namespace", () => {
    renderRefs(3);

    expect(refState.targets).toEqual([
      {
        namespace: "local",
        revision: 3,
        target: { environmentId, cwd: repositoryCwd, query: "" },
      },
      { namespace: "remote", revision: 3, target: { environmentId: null, cwd: null } },
      { namespace: "tag", revision: 3, target: { environmentId: null, cwd: null } },
    ]);
  });

  it("waits for the ref filter debounce before querying collapsed remote and tag namespaces", () => {
    const first = renderRefs();
    first.historyRefs.setRefFilter("release");
    refState.targets = [];

    renderRefs();

    expect(refState.targets).toContainEqual({
      namespace: "remote",
      revision: 0,
      target: { environmentId: null, cwd: null },
    });
    expect(refState.targets).toContainEqual({
      namespace: "tag",
      revision: 0,
      target: { environmentId: null, cwd: null },
    });
  });
});
