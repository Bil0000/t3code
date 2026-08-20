import { EnvironmentId, type VcsHistoryRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const refState = vi.hoisted(() => ({
  currentRefResolved: true,
  currentRef: null as VcsHistoryRef | null,
  debouncedRefFilter: "",
  local: [] as ReadonlyArray<VcsHistoryRef>,
  remote: [] as ReadonlyArray<VcsHistoryRef>,
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  isComplete: true,
  refreshLocal: vi.fn(),
  refreshRemote: vi.fn(),
  refreshTags: vi.fn(),
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
    return {
      data:
        options.namespace === "local" && !refState.currentRefResolved
          ? null
          : { currentRef: refState.currentRef, nextCursor: null, isComplete: refState.isComplete },
      refs,
      error: null,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      refresh:
        options.namespace === "local"
          ? refState.refreshLocal
          : options.namespace === "remote"
            ? refState.refreshRemote
            : refState.refreshTags,
      retry: vi.fn(),
    };
  },
}));

import { GitRefsPane } from "./GitHistoryRefsPane";
import { useGitHistoryRefs } from "./useGitHistoryRefs";

const environmentId = EnvironmentId.make("environment-local");

function ref(name: string, isRemote = false): VcsHistoryRef {
  return { current: false, isDefault: false, isRemote, name, worktreePath: null };
}

function renderRefs(revision = 0) {
  hooks.beginRender();
  const historyRefs = useGitHistoryRefs(environmentId, "C:/workspace", revision);
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
    sharedRefTreeProps: {
      filterActive: false,
      expanded: historyRefs.expandedRefKeys,
      selectedRevision: historyRefs.selectedRevision?.revision ?? null,
      onToggle: historyRefs.toggleRefKey,
      onSelect: historyRefs.selectRef,
    },
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
    refState.debouncedRefFilter = "";
    refState.local = Array.from({ length: 5_000 }, (_, index) => ref(`feature-${index}`));
    refState.remote = Array.from({ length: 5_000 }, (_, index) => ref(`origin-${index}`, true));
    refState.tags = [];
    refState.isComplete = true;
    refState.refreshLocal.mockReset();
    refState.refreshRemote.mockReset();
    refState.refreshTags.mockReset();
    refState.targets = [];
  });

  it("preserves ref trees and the 10k-row virtual-list model across unchanged rerenders", () => {
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
    refState.isComplete = false;

    const rendered = renderRefs();

    expect(rendered.capStatus?.props.children).toBe("Showing the first 10,000 matching refs.");
  });

  it("refreshes local refs without invalidating the other ref namespaces", () => {
    const rendered = renderRefs();

    rendered.historyRefs.refreshRefs();

    expect(refState.refreshLocal).toHaveBeenCalledOnce();
    expect(refState.refreshRemote).not.toHaveBeenCalled();
    expect(refState.refreshTags).not.toHaveBeenCalled();
  });

  it("keeps the history revision unresolved until the local ref snapshot resolves", () => {
    refState.currentRefResolved = false;

    const rendered = renderRefs();

    expect(rendered.historyRefs.currentRef).toBeUndefined();
    expect(rendered.historyRefs.selectedRevision).toBeUndefined();
  });

  it("keeps the default selected revision stable across unchanged rerenders", () => {
    refState.currentRef = ref("main");

    const first = renderRefs();
    const second = renderRefs();

    expect(second.historyRefs.selectedRevision).toBe(first.historyRefs.selectedRevision);
  });

  it("passes a repository revision to every history ref namespace", () => {
    renderRefs(3);

    expect(refState.targets).toEqual([
      {
        namespace: "local",
        revision: 3,
        target: { environmentId, cwd: "C:/workspace", query: "" },
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
