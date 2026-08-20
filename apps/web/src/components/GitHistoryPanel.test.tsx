import {
  EnvironmentId,
  VcsSnapshotExpiredError,
  type GitCommitDetails,
  type GitHistoryCommit,
  type VcsGetHistoryResult,
  type VcsListCommitFilesResult,
  type VcsHistoryRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

type PageResult =
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Success"; readonly waiting: false; readonly value: VcsGetHistoryResult };

type PageAtom = { readonly result: PageResult };

const effectQueue = vi.hoisted(() => ({
  cursor: 0,
  dependencies: [] as Array<ReadonlyArray<unknown> | undefined>,
  effects: [] as Array<() => void>,
  stateUpdates: 0,
}));

const historyState = vi.hoisted(() => ({
  commitDetails: null as GitCommitDetails | null,
  diff: { diff: "", isRepo: true, truncated: false },
  getCommitDetails: vi.fn(),
  listCommitFiles: vi.fn(),
  commitFiles: {
    files: [],
    isRepo: true,
    nextCursor: null,
    hasMore: false,
    capped: false,
  } as VcsListCommitFilesResult,
  commitFilesErrorCause: null as Cause.Cause<unknown> | null,
  commitFilesRefresh: vi.fn(),
  getCommitDiff: vi.fn(),
  getHistory: vi.fn(),
  historyRevision: 0,
  connection: { phase: "connected", generation: 1 } as {
    readonly phase: string;
    readonly generation: number;
  },
  pages: new Map<string | undefined, PageResult>(),
  refresh: vi.fn(),
  refreshRefs: vi.fn(),
  refreshRemoteRefs: vi.fn(),
  refreshTags: vi.fn(),
  toastAdd: vi.fn(),
  refs: [] as ReadonlyArray<VcsHistoryRef>,
  refsResolved: true,
  refsError: null as string | null,
  retryRefs: vi.fn(),
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  status: { aheadCount: 0, behindCount: 0 },
}));

const fontState = vi.hoisted(() => ({ interfaceSize: 16 }));

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options?: { readonly onError?: (error: Error) => void }) => ({
    copyToClipboard: () => options?.onError?.(new Error("Clipboard permission was denied.")),
    isCopied: false,
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <Value,>(
    selector: (settings: { readonly fontSizeInterface: number }) => Value,
  ) => selector({ fontSizeInterface: fontState.interfaceSize }),
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: historyState.toastAdd },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useDeferredValue: <Value,>(value: Value) => value,
    useEffect: (effect: () => void, dependencies?: ReadonlyArray<unknown>) => {
      const index = effectQueue.cursor++;
      const previous = effectQueue.dependencies[index];
      if (
        previous !== undefined &&
        dependencies !== undefined &&
        previous.length === dependencies.length &&
        previous.every((value, dependencyIndex) => Object.is(value, dependencies[dependencyIndex]))
      ) {
        return;
      }
      effectQueue.dependencies[index] = dependencies;
      effectQueue.effects.push(effect);
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: <Value,>(initialValue: Value | (() => Value)) => {
      const [value, setValue] = reactHookHarness.useState(initialValue);
      return [
        value,
        (nextValue: Value | ((previous: Value) => Value)) => {
          effectQueue.stateUpdates += 1;
          setValue(nextValue);
        },
      ] as const;
    },
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly value: ReadonlyArray<PageAtom["result"]> }) => atom.value,
}));

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    AsyncResult: {
      ...actual.AsyncResult,
      value: (result: PageAtom["result"]) =>
        result._tag === "Success" ? Option.some(result.value) : Option.none(),
    },
    Atom: {
      ...actual.Atom,
      make: (
        create: (get: (atom: PageAtom) => PageAtom["result"]) => ReadonlyArray<PageAtom["result"]>,
      ) => {
        const value = create((atom) => atom.result);
        return {
          pipe: () => ({ value }),
          value,
        };
      },
      withLabel: () => (atom: unknown) => atom,
    },
  };
});

vi.mock("@legendapp/list/react", () => ({
  LegendList: () => null,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: historyState.refresh },
}));

vi.mock("../state/queries", () => ({
  useDebouncedValue: <Value,>(value: Value) => value,
  usePaginatedHistoryRefs: (_target: unknown, options?: { readonly namespace?: string }) => {
    const refs = options?.namespace === "tag" ? historyState.tags : historyState.refs;
    return {
      data: historyState.refsResolved
        ? {
            refs,
            isRepo: true,
            hasPrimaryRemote: false,
            nextCursor: null,
            currentRef: refs.find((ref) => ref.current) ?? null,
            isComplete: true,
          }
        : null,
      refs,
      error: options?.namespace === "local" ? historyState.refsError : null,
      isPending: false,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      retry: historyState.retryRefs,
      refresh:
        options?.namespace === "tag"
          ? historyState.refreshTags
          : options?.namespace === "remote"
            ? historyState.refreshRemoteRefs
            : historyState.refreshRefs,
    };
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (target: { readonly kind?: string } | null) => {
    const base = { error: null, errorCause: null, isPending: false, refresh: vi.fn() };
    if (target?.kind === "status") return { ...base, data: historyState.status };
    if (target?.kind === "commit-details")
      return { ...base, data: { commit: historyState.commitDetails } };
    if (target?.kind === "commit-files") {
      const errorCause = historyState.commitFilesErrorCause;
      return {
        ...base,
        data: errorCause === null ? historyState.commitFiles : null,
        error: errorCause === null ? null : "Git browsing snapshot expired.",
        errorCause,
        refresh: historyState.commitFilesRefresh,
      };
    }
    if (target?.kind === "commit-diff") return { ...base, data: historyState.diff };
    return { ...base, data: null };
  },
}));

vi.mock("../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: historyState.connection }),
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    historyRevisionAtom: () => ({ value: historyState.historyRevision }),
    getHistory: (target: { readonly input: { readonly cursor?: string } }) => {
      historyState.getHistory(target);
      const value = historyState.pages.get(target.input.cursor);
      return { result: value ?? page([]) } satisfies PageAtom;
    },
    getCommitDetails: (target: unknown) => {
      historyState.getCommitDetails(target);
      return { kind: "commit-details" };
    },
    listCommitFiles: (target: { readonly input: unknown }) => {
      historyState.listCommitFiles(target);
      return { kind: "commit-files", input: target.input };
    },
    getCommitDiff: (target: unknown) => {
      historyState.getCommitDiff(target);
      return { kind: "commit-diff" };
    },
    status: () => ({ kind: "status" }),
  },
}));

import {
  appendCommitFilesPage,
  nextCommitFilesCursor,
  nextCommitFilesRecoveryGeneration,
  isWideHistoryLayout,
} from "./GitHistoryPanel";
import GitHistoryPanel from "./GitHistoryPanel";
import { CommitDiffView } from "./git-history/GitHistoryCommitDiff";
import { PaneResizeHandle } from "./git-history/GitHistoryPaneResizeHandle";

const environmentId = EnvironmentId.make("environment-local");
const workspacePath = "C:/workspace";
const historyPageSize = 100;
const primaryCommitHash = "aaaaaaaa11111111111111111111111111111111";
const secondaryCommitHash = "bbbbbbbb22222222222222222222222222222222";
const newestMatchingCommitHash = "cccccccc33333333333333333333333333333333";

function commit(hash: string, subject: string, authorName = "Ada Lovelace"): GitHistoryCommit {
  return {
    hash,
    parentHashes: [],
    subject,
    authorName,
    authorEmail: "ada@example.com",
    authoredAt: "2026-08-01T12:00:00.000Z",
    refs: [],
  };
}

function page(
  commits: ReadonlyArray<GitHistoryCommit>,
  options?: {
    readonly capped?: boolean;
    readonly hasMore?: boolean;
    readonly nextCursor?: string | null;
  },
): PageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      commits,
      isRepo: true,
      hasMore: options?.hasMore ?? false,
      nextCursor: options?.nextCursor ?? null,
      capped: options?.capped,
    },
  };
}

const expiredHistoryPage = (): PageResult => ({
  _tag: "Failure",
  cause: Cause.fail(
    Object.assign(new Error("Git browsing snapshot expired."), { _tag: "VcsSnapshotExpiredError" }),
  ),
});

function expiredSnapshotCause(): Cause.Cause<unknown> {
  return Cause.fail(
    new VcsSnapshotExpiredError({
      operation: "GitVcsDriver.listCommitFiles",
      cursor: "expired-cursor",
    }),
  );
}

function gitRef(
  name: string,
  options?: {
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly current?: boolean;
    readonly isRemote?: boolean;
    readonly isTag?: boolean;
    readonly upstreamName?: string;
  },
): VcsHistoryRef {
  return {
    name,
    current: options?.current ?? false,
    isDefault: false,
    isRemote: options?.isRemote ?? false,
    ...(options?.isTag ? { isTag: true } : {}),
    ...(options?.aheadCount === undefined ? {} : { aheadCount: options.aheadCount }),
    ...(options?.behindCount === undefined ? {} : { behindCount: options.behindCount }),
    ...(options?.upstreamName === undefined ? {} : { upstreamName: options.upstreamName }),
    worktreePath: null,
  };
}

function renderPanel(issueUrlPrefix?: string): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  effectQueue.cursor = 0;
  return GitHistoryPanel({
    environmentId,
    cwd: workspacePath,
    ...(issueUrlPrefix ? { issueUrlPrefix } : {}),
  }) as ReactElement<Record<string, unknown>>;
}

function flushEffects(): void {
  const effects = effectQueue.effects.splice(0);
  for (const effect of effects) effect();
}

function stubResizeObserver(initialWidth: number): (width: number) => void {
  let notify: ((width: number) => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: ReadonlyArray<{ contentRect: { width: number } }>) => void) {
        notify = (width) => callback([{ contentRect: { width } }]);
      }

      disconnect() {}

      observe() {
        notify?.(initialWidth);
      }
    },
  );
  return (width) => notify?.(width);
}

function historyList(panel: ReactElement<Record<string, unknown>>) {
  const list = visitElements(
    panel,
    (element) =>
      typeof element.props.estimatedItemSize === "number" &&
      typeof element.props.keyExtractor === "function",
  );
  expect(list).not.toBeNull();
  return list as ReactElement<{
    readonly data: ReadonlyArray<{
      readonly commit: GitHistoryCommit;
      readonly graph: { readonly edges: ReadonlyArray<{ readonly kind: string }> };
    }>;
    readonly renderItem: (props: {
      readonly item: {
        readonly commit: GitHistoryCommit;
        readonly graph: { readonly edges: ReadonlyArray<unknown> };
      };
    }) => ReactElement<Record<string, unknown>>;
    readonly estimatedItemSize: number;
    readonly onEndReached?: () => void;
    readonly recycleItems?: boolean;
  }>;
}

function loadMoreHistory(panel: ReactElement<Record<string, unknown>>): void {
  const footer = visitElements(
    panel,
    (element) =>
      element.props.className === "flex shrink-0 justify-center border-t border-border/50 p-2",
  );
  const loadMore = visitElements(footer, (element) => element.props.children === "Load more");
  expect(loadMore).not.toBeNull();
  (loadMore?.props.onClick as (() => void) | undefined)?.();
}

function renderComponent(
  element: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = element.type as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement<Record<string, unknown>>;
  return component(element.props);
}

function componentTree(
  panel: ReactElement<Record<string, unknown>>,
  componentName: string,
  props?: Partial<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = visitElements(
    panel,
    (element) =>
      typeof element.type === "function" &&
      element.type.name === componentName &&
      Object.entries(props ?? {}).every(([key, value]) => element.props[key] === value),
  );
  expect(component).not.toBeNull();
  return renderComponent(component as ReactElement<Record<string, unknown>>);
}

function componentElement(
  panel: ReactElement<Record<string, unknown>>,
  componentName: string,
): ReactElement<Record<string, unknown>> {
  const component = visitElements(
    panel,
    (element) => typeof element.type === "function" && element.type.name === componentName,
  );
  expect(component).not.toBeNull();
  return component as ReactElement<Record<string, unknown>>;
}

describe("GitHistoryPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    hooks.reset();
    fontState.interfaceSize = 16;
    effectQueue.cursor = 0;
    effectQueue.dependencies.length = 0;
    effectQueue.effects.length = 0;
    effectQueue.stateUpdates = 0;
    historyState.commitDetails = null;
    historyState.diff = { diff: "", isRepo: true, truncated: false };
    historyState.getCommitDetails.mockReset();
    historyState.listCommitFiles.mockReset();
    historyState.commitFiles = {
      files: [],
      isRepo: true,
      nextCursor: null,
      hasMore: false,
      capped: false,
    };
    historyState.commitFilesErrorCause = null;
    historyState.commitFilesRefresh.mockReset();
    historyState.getCommitDiff.mockReset();
    historyState.getHistory.mockReset();
    historyState.historyRevision = 0;
    historyState.connection = { phase: "connected", generation: 1 };
    historyState.pages.clear();
    historyState.refresh.mockReset();
    historyState.refreshRefs.mockReset();
    historyState.refreshRemoteRefs.mockReset();
    historyState.refreshTags.mockReset();
    historyState.toastAdd.mockReset();
    historyState.refs = [];
    historyState.refsResolved = true;
    historyState.refsError = null;
    historyState.retryRefs.mockReset();
    historyState.tags = [];
    historyState.status = { aheadCount: 0, behindCount: 0 };
  });

  it("does not start an all-refs history request while the current ref is unresolved", () => {
    historyState.refsResolved = false;

    renderPanel();

    expect(historyState.getHistory).not.toHaveBeenCalled();
  });

  it("shows an initial ref failure with a reachable retry while loading all history", () => {
    historyState.refsResolved = false;
    historyState.refsError = "Could not load refs.";
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const panel = renderPanel();
    const refsPane = componentElement(panel, "GitRefsPane");

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
    expect(refsPane.props.refPaginationError).toBe("Could not load refs.");
    (refsPane.props.onRetryRefs as () => void)();
    expect(historyState.retryRefs).toHaveBeenCalledOnce();
  });

  it("notices a server-capped history result before the client page limit", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "Initial")], { capped: true }),
    );

    const panel = renderPanel();

    expect(
      visitElements(
        panel,
        (element) => element.props.children === "History results were capped by the server.",
      ),
    ).not.toBeNull();
  });

  it("restarts history after the environment connection generation changes", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    renderPanel();
    historyState.getHistory.mockClear();
    historyState.connection = { phase: "connected", generation: 2 };

    renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });

  it("keeps the narrow branches sheet open when the history target rekeys", () => {
    stubResizeObserver(539);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branches = visitElements(
      renderPanel(),
      (element) => element.props["aria-controls"] === "git-history-refs-panel",
    );
    (branches?.props.onClick as (() => void) | undefined)?.();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-refs-panel",
      )?.props["aria-expanded"],
    ).toBe(true);

    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();
    flushEffects();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-refs-panel",
      )?.props["aria-expanded"],
    ).toBe(true);
  });

  it("closes the narrow details sheet when the history target rekeys", () => {
    stubResizeObserver(539);
    const historyCommit = commit(primaryCommitHash, "Initial");
    historyState.pages.set(undefined, page([historyCommit]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    const details = visitElements(
      renderPanel(),
      (element) => element.props["aria-controls"] === "git-history-details-panel",
    );
    (details?.props.onClick as (() => void) | undefined)?.();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-details-panel",
      )?.props["aria-expanded"],
    ).toBe(true);

    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();
    flushEffects();

    expect(
      visitElements(
        renderPanel(),
        (element) => element.props["aria-controls"] === "git-history-details-panel",
      )?.props["aria-expanded"],
    ).toBe(false);
  });

  it("restarts the first history page after a typed continuation expiry", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "First")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", expiredHistoryPage());

    const first = renderPanel();
    loadMoreHistory(first);
    renderPanel();
    flushEffects();
    renderPanel();

    const requests = historyState.getHistory.mock.calls.map(([target]) => target);
    expect(requests).toContainEqual({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, cursor: "history-page-2", limit: historyPageSize },
    });
    expect(requests.at(-1)).toEqual({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });

  it("recovers a second continuation expiry once after a successful recovery", () => {
    const firstPage = page([commit(primaryCommitHash, "First")], {
      hasMore: true,
      nextCursor: "history-page-2",
    });
    historyState.pages.set(undefined, firstPage);
    historyState.pages.set("history-page-2", expiredHistoryPage());

    const first = renderPanel();
    loadMoreHistory(first);
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();

    const recovered = renderPanel();
    loadMoreHistory(recovered);
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();
    renderPanel();
    flushEffects();

    const generations = historyState.getHistory.mock.calls.map(([target]) => target.cacheKey);
    expect(generations).toContain(2);
    expect(generations).not.toContain(3);
    expect(generations.at(-1)).toBe(2);
  });

  it("rekeys open history reads when the shared VCS history revision changes", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    const details = renderPanel();
    const detailsPane = componentTree(details, "CommitDetailsPane");
    const showDiff = visitElements(
      detailsPane,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("View all changes"),
    );
    (showDiff?.props.onClick as (() => void) | undefined)?.();
    renderPanel();

    historyState.historyRevision = 1;
    renderPanel();

    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
    expect(historyState.getCommitDetails).toHaveBeenLastCalledWith({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
    expect(historyState.listCommitFiles).toHaveBeenLastCalledWith({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash, limit: 100 },
    });
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      cacheKey: 1,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
  });

  it("discards loaded history cursor pages when the environment reconnects", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "First")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", page([commit(secondaryCommitHash, "Second")]));

    const initial = renderPanel();
    loadMoreHistory(initial);
    renderPanel();
    historyState.connection = { phase: "connected", generation: 2 };
    renderPanel();

    expect(
      historyState.getHistory.mock.calls.slice(-3).map(([target]) => target.input.cursor),
    ).toEqual([undefined, "history-page-2", undefined]);
  });

  it("keeps graph rows stable when history query results have not changed", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "First")]));

    const first = historyList(renderPanel());
    const second = historyList(renderPanel());

    expect(second.props.data).toBe(first.props.data);
  });

  it("keeps row separators out of the graph column", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    const content = visitElements(
      historyRow,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("grid-cols-") &&
        element.props.className.includes("border-b"),
    );

    expect(historyRow.props.className).not.toContain("border-b");
    expect(graph).not.toBeNull();
    expect(content).not.toBeNull();

    const graphRoot = renderComponent(graph!);
    const graphSvg = visitElements(graphRoot, (element) => element.type === "svg");
    expect(graphRoot.props.className).not.toContain("overflow-visible");
    expect(graphSvg).not.toBeNull();
    expect(graphSvg!.props.className).toBe("absolute inset-0");
    expect(graphSvg!.props.height).toBe(30);
    expect(graphSvg!.props.viewBox).toBe("0 0 44 30");
  });

  it("scales the list and graph geometry with the interface font size", () => {
    fontState.interfaceSize = 20;
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    expect(graph).not.toBeNull();
    const graphRoot = renderComponent(graph!);
    const graphSvg = visitElements(graphRoot, (element) => element.type === "svg");

    expect(list.props.estimatedItemSize).toBe(37.5);
    expect(historyRow.props.style).toMatchObject({ height: 37.5 });
    expect(graphSvg!.props.height).toBe(37.5);
    expect(graphSvg!.props.viewBox).toBe("0 0 44 37.5");
  });

  it("keeps graph paths within each paint-contained row while joining adjacent lanes", () => {
    fontState.interfaceSize = 20;
    const parent = commit(secondaryCommitHash, "Parent");
    const child = {
      ...commit(primaryCommitHash, "Child"),
      parentHashes: [parent.hash],
    };
    historyState.pages.set(undefined, page([child, parent]));

    const list = historyList(renderPanel());
    const graphRoots = list.props.data.map((row) => {
      const historyRow = renderComponent(list.props.renderItem({ item: row }));
      const graph = visitElements(
        historyRow,
        (element) => typeof element.type === "function" && element.type.name === "GraphCell",
      );
      expect(graph).not.toBeNull();
      return renderComponent(graph!);
    });
    const childSvg = visitElements(graphRoots[0], (element) => element.type === "svg");
    const parentSvg = visitElements(graphRoots[1], (element) => element.type === "svg");
    const childParentEdge = visitElements(
      graphRoots[0],
      (element) => element.props["data-edge-kind"] === "parent",
    );
    const parentIncoming = visitElements(
      graphRoots[1],
      (element) => element.type === "line" && element.props.y1 === "0",
    );

    expect(childSvg).not.toBeNull();
    expect(parentSvg).not.toBeNull();
    expect(childSvg!.props.className).toBe("absolute inset-0");
    expect(childSvg!.props.viewBox).toBe("0 0 44 37.5");
    expect(childSvg!.props.height).toBe(37.5);
    expect(childParentEdge!.props.d).toContain("L 11.5 37.5");
    expect(childParentEdge!.props.strokeLinecap).toBe("square");
    expect(parentIncoming).not.toBeNull();
    expect(parentIncoming!.props.strokeLinecap).toBe("square");
  });

  it("keeps missing-parent graph paths dashed without boundary overlays", () => {
    const child = {
      ...commit(primaryCommitHash, "Child"),
      parentHashes: [secondaryCommitHash],
    };
    historyState.pages.set(undefined, page([child]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const graph = visitElements(
      historyRow,
      (element) => typeof element.type === "function" && element.type.name === "GraphCell",
    );
    expect(graph).not.toBeNull();
    const graphRoot = renderComponent(graph!);
    const missingParent = visitElements(
      graphRoot,
      (element) =>
        element.props["data-edge-kind"] === "parent" && element.props.strokeDasharray === "3 2",
    );

    expect(missingParent).not.toBeNull();
    expect(missingParent!.props.strokeLinecap).toBe("butt");
  });

  it("creates a fresh changed-file first-page generation after each recovered snapshot expiry", () => {
    const errorCause = expiredSnapshotCause();
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };
    historyState.commitFiles = {
      files: [{ status: "M", path: "stale.ts" }],
      isRepo: true,
      nextCursor: "stale-cursor",
      hasMore: true,
      capped: true,
    };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    renderPanel();
    flushEffects();
    expect(componentElement(renderPanel(), "CommitDetailsPane").props).toMatchObject({
      files: [{ status: "M", path: "stale.ts" }],
      filesCapped: true,
      filesHasMore: true,
    });

    historyState.commitFilesErrorCause = errorCause;
    renderPanel();
    flushEffects();
    expect(componentElement(renderPanel(), "CommitDetailsPane").props).toMatchObject({
      files: [],
      filesCapped: false,
      filesHasMore: false,
    });

    expect(
      nextCommitFilesRecoveryGeneration({ errorCause, generation: 0, recoveryInFlight: false }),
    ).toBe(1);
    expect(
      nextCommitFilesRecoveryGeneration({ errorCause, generation: 1, recoveryInFlight: true }),
    ).toBeNull();
    expect(
      nextCommitFilesRecoveryGeneration({ errorCause, generation: 1, recoveryInFlight: false }),
    ).toBe(2);
  });

  it("renders populated history rows through the virtualized list", () => {
    historyState.pages.set(
      undefined,
      page([
        commit(primaryCommitHash, "Add Git history panel"),
        commit(secondaryCommitHash, "Expose commit graph", "Grace Hopper"),
      ]),
    );

    const panel = renderPanel();
    const list = historyList(panel);

    expect(list.props.data.map((row) => row.commit.subject)).toEqual([
      "Add Git history panel",
      "Expose commit graph",
    ]);
    expect(list.props.recycleItems).toBe(false);
    expect(historyState.getHistory).toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, limit: historyPageSize },
    });
  });

  it("keeps the desktop refs and details workflow available at ordinary desktop widths", () => {
    expect(isWideHistoryLayout(1119)).toBe(false);
    expect(isWideHistoryLayout(1120)).toBe(true);
  });

  it("coalesces pane pointer moves per frame and flushes the final move on pointer up", () => {
    const onMove = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    hooks.beginRender();
    const handle = PaneResizeHandle({
      label: "Resize branches pane",
      value: 320,
      min: 240,
      max: 480,
      onMove,
      onReset: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const target = { releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() };
    const onPointerDown = handle.props.onPointerDown as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;
    const onPointerMove = handle.props.onPointerMove as (event: {
      readonly clientX: number;
      readonly pointerId: number;
    }) => void;
    const onPointerUp = handle.props.onPointerUp as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;

    onPointerDown({ clientX: 100, currentTarget: target, pointerId: 1 });
    onPointerMove({ clientX: 104, pointerId: 1 });
    onPointerMove({ clientX: 110, pointerId: 1 });

    expect(onMove).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    const firstFrame = frames.get(1);
    expect(firstFrame).toBeDefined();
    frames.delete(1);
    firstFrame?.(0);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(10);

    onPointerMove({ clientX: 114, pointerId: 1 });
    onPointerUp({ clientX: 120, currentTarget: target, pointerId: 1 });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenLastCalledWith(10);
    expect(frames).toHaveLength(0);
  });

  it("flushes pending pane movement once when pointer capture is lost before its frame", () => {
    const onMove = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(1, callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    hooks.beginRender();
    const handle = PaneResizeHandle({
      label: "Resize branches pane",
      value: 320,
      min: 240,
      max: 480,
      onMove,
      onReset: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const target = { setPointerCapture: vi.fn() };
    const onPointerDown = handle.props.onPointerDown as (event: {
      readonly clientX: number;
      readonly currentTarget: typeof target;
      readonly pointerId: number;
    }) => void;
    const onPointerMove = handle.props.onPointerMove as (event: {
      readonly clientX: number;
      readonly pointerId: number;
    }) => void;
    const onLostPointerCapture = handle.props.onLostPointerCapture as (event: {
      readonly pointerId: number;
    }) => void;

    onPointerDown({ clientX: 100, currentTarget: target, pointerId: 1 });
    onPointerMove({ clientX: 110, pointerId: 1 });
    const pendingFrame = frames.get(1);
    onLostPointerCapture({ pointerId: 1 });
    pendingFrame?.(0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith(10);
  });

  it("does not rerender history children for repeated wide widths without pane clamping", () => {
    const notify = stubResizeObserver(1400);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    effectQueue.stateUpdates = 0;

    notify(1399);
    notify(1398);
    notify(1397);

    expect(effectQueue.stateUpdates).toBe(0);
  });

  it("constrains both side panes when widening branches at the minimum wide layout", () => {
    stubResizeObserver(1120);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branchHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);

    const constrained = renderPanel();
    const refsPane = componentElement(constrained, "GitRefsPane");
    const detailsPane = componentElement(constrained, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(304);
  });

  it("constrains commit details when resetting at the minimum wide layout", () => {
    stubResizeObserver(1120);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const branchHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    const detailsHandle = visitElements(
      renderPanel(),
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    (detailsHandle?.props.onReset as (() => void) | undefined)?.();

    const constrained = renderPanel();
    const refsPane = componentElement(constrained, "GitRefsPane");
    const detailsPane = componentElement(constrained, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(304);
  });

  it("clamps expanded side panes when a wide history panel shrinks", () => {
    const notify = stubResizeObserver(1400);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const expanded = renderPanel();
    const branchHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    const detailsHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    expect(branchHandle).not.toBeNull();
    expect(detailsHandle).not.toBeNull();
    expect(renderComponent(branchHandle!).props.className).not.toContain("hidden");
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    (detailsHandle?.props.onMove as ((delta: number) => void) | undefined)?.(-336);

    notify(1120);
    renderPanel();
    flushEffects();
    const shrunken = renderPanel();
    const refsPane = componentElement(shrunken, "GitRefsPane");
    const detailsPane = componentElement(shrunken, "CommitDetailsPane");
    const refsWidth = (refsPane.props.style as { width: number }).width;
    const detailsWidth = (detailsPane.props.style as { width: number }).width;

    expect(refsWidth + detailsWidth).toBeLessThanOrEqual(784);
  });

  it("preserves wide pane widths through a narrow layout transition", () => {
    const notify = stubResizeObserver(1600);
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const initial = renderPanel();
    (initial.props.ref as { current: object | null }).current = {};
    flushEffects();
    const expanded = renderPanel();
    const branchHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize branches pane",
    );
    const detailsHandle = visitElements(
      expanded,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "PaneResizeHandle" &&
        element.props.label === "Resize commit details pane",
    );
    (branchHandle?.props.onMove as ((delta: number) => void) | undefined)?.(224);
    (detailsHandle?.props.onMove as ((delta: number) => void) | undefined)?.(-336);

    notify(1119);
    renderPanel();
    flushEffects();
    notify(1600);
    renderPanel();
    flushEffects();
    const restored = renderPanel();
    const refsPane = componentElement(restored, "GitRefsPane");
    const detailsPane = componentElement(restored, "CommitDetailsPane");

    expect((refsPane.props.style as { width: number }).width).toBe(480);
    expect((detailsPane.props.style as { width: number }).width).toBe(720);
  });

  it("filters history by commit message", () => {
    historyState.pages.set(
      undefined,
      page([
        commit(primaryCommitHash, "Prepare release"),
        commit(secondaryCommitHash, "Fix graph layout"),
      ]),
    );

    const panel = renderPanel();
    const filter = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    expect(filter).not.toBeNull();
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({
      target: { value: "release" },
    });

    const filtered = historyList(renderPanel());
    expect(filtered.props.data.map((row) => row.commit.subject)).toEqual(["Prepare release"]);
  });

  it("keeps a history search to the loaded page until the user requests older commits", () => {
    historyState.pages.set(
      undefined,
      page([commit(primaryCommitHash, "Fix graph layout")], {
        hasMore: true,
        nextCursor: "history-page-2",
      }),
    );
    historyState.pages.set("history-page-2", page([commit(secondaryCommitHash, "Release notes")]));

    const initialPanel = renderPanel();
    flushEffects();
    const filter = visitElements(
      initialPanel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({ target: { value: "release" } });
    renderPanel();
    flushEffects();
    const filteredPanel = renderPanel();

    expect(historyState.getHistory).toHaveBeenCalledTimes(1);
    expect(historyState.getHistory).not.toHaveBeenCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        cursor: "history-page-2",
        limit: historyPageSize,
      },
    });
    const searchOlder = visitElements(
      filteredPanel,
      (element) => element.props.children === "Search older commits",
    );
    expect(searchOlder).not.toBeNull();
  });

  it("clears a hash search from the clear button or Escape key", () => {
    const matchingCommitHash = "0acf007c21111111111111111111111111111111";
    historyState.pages.set(
      undefined,
      page([
        commit(matchingCommitHash, "Matching commit"),
        commit(secondaryCommitHash, "Other commit"),
      ]),
    );

    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const changeSearch = search?.props.onChange as
      | ((event: { readonly target: { readonly value: string } }) => void)
      | undefined;
    changeSearch?.({ target: { value: "0acf007c2" } });
    expect(historyList(renderPanel()).props.data).toHaveLength(1);

    const clear = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Clear Git history search",
    );
    (clear?.props.onClick as (() => void) | undefined)?.();
    expect(historyList(renderPanel()).props.data).toHaveLength(2);

    changeSearch?.({ target: { value: "0acf007c2" } });
    const filteredSearch = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const preventDefault = vi.fn();
    (
      filteredSearch?.props.onKeyDown as
        | ((event: { readonly key: string; readonly preventDefault: () => void }) => void)
        | undefined
    )?.({ key: "Escape", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(historyList(renderPanel()).props.data).toHaveLength(2);
  });

  it("keeps a trailing-space search visible, literal, and clearable", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Add Git history panel")]));

    const search = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    const changeSearch = search?.props.onChange as
      | ((event: { readonly target: { readonly value: string } }) => void)
      | undefined;
    const historyQueryCallCount = historyState.getHistory.mock.calls.length;
    changeSearch?.({ target: { value: "fix " } });

    const filteredPanel = renderPanel();
    const filteredSearch = visitElements(
      filteredPanel,
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    expect(filteredSearch).not.toBeNull();
    expect(filteredSearch?.props.value).toBe("fix ");
    expect(historyState.getHistory).toHaveBeenCalledTimes(historyQueryCallCount);
    const clear = visitElements(
      filteredPanel,
      (element) => element.props["aria-label"] === "Clear Git history search",
    );
    expect(clear).not.toBeNull();
    (clear?.props.onClick as (() => void) | undefined)?.();
    expect(historyList(renderPanel()).props.data).toHaveLength(1);
  });

  it("rebuilds the graph from the text-filtered commits", () => {
    historyState.pages.set(
      undefined,
      page([
        {
          ...commit(newestMatchingCommitHash, "Match newest"),
          parentHashes: ["b"],
        },
        {
          ...commit(secondaryCommitHash, "Hidden parent"),
          parentHashes: ["a"],
        },
        commit(primaryCommitHash, "Match oldest"),
      ]),
    );

    const filter = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Filter Git history",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({ target: { value: "match" } });

    const filtered = historyList(renderPanel());
    expect(filtered.props.data.map((row) => row.commit.hash)).toEqual([
      newestMatchingCommitHash,
      primaryCommitHash,
    ]);
    expect(filtered.props.data.flatMap((row) => row.graph.edges)).not.toContainEqual(
      expect.objectContaining({ kind: "parent" }),
    );
  });

  it("deduplicates overlapping pages and keeps Load more in the scrolling column footer", () => {
    const duplicate = commit(primaryCommitHash, "Initial commit");
    historyState.pages.set(
      undefined,
      page([duplicate], { hasMore: true, nextCursor: "next-page" }),
    );
    historyState.pages.set(
      "next-page",
      page([duplicate, commit(secondaryCommitHash, "Second page commit")]),
    );

    const panel = renderPanel();
    const scrollingColumn = visitElements(
      panel,
      (element) => element.props.className === "flex h-full min-w-0 flex-col",
    );
    expect(scrollingColumn).not.toBeNull();
    const footer = visitElements(
      scrollingColumn,
      (element) =>
        element.props.className === "flex shrink-0 justify-center border-t border-border/50 p-2",
    );
    expect(footer).not.toBeNull();
    const loadMore = visitElements(footer, (element) => element.props.children === "Load more");
    expect(loadMore).not.toBeNull();
    (loadMore?.props.onClick as (() => void) | undefined)?.();

    const expanded = historyList(renderPanel());
    expect(expanded.props.data.map((row) => row.commit.hash)).toEqual([
      primaryCommitHash,
      secondaryCommitHash,
    ]);
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        cursor: "next-page",
        limit: historyPageSize,
      },
    });
  });

  it("filters, expands, and selects nested branches while showing the branch commit count", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));
    historyState.refs = [
      gitRef("feature/api"),
      gitRef("feature/ui", {
        aheadCount: 10,
        current: true,
        upstreamName: "origin/feature/ui",
      }),
      gitRef("development", {
        aheadCount: 3,
        behindCount: 2,
        upstreamName: "origin/development",
      }),
      gitRef("main"),
    ];
    historyState.status = { aheadCount: 3, behindCount: 2 };

    const initial = renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/heads/feature/ui",
      },
    });
    const initialPane = componentTree(initial, "GitRefsPane");
    const initialList = componentElement(initialPane, "LegendList");
    expect(initialList.props.recycleItems).toBe(true);
    const initialRows = initialList.props.data as Array<{
      readonly key: string;
      readonly open?: boolean;
    }>;
    const featureFolder = initialRows.find((row) => row.key === "local:feature");
    expect(featureFolder?.open).toBe(false);

    const renderInitialRow = initialList.props.renderItem as (props: {
      readonly item: (typeof initialRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const featureFolderRow = renderInitialRow({ item: featureFolder! });
    const featureFolderButton = visitElements(
      featureFolderRow,
      (element) => element.props["aria-expanded"] === false,
    );
    (featureFolderButton?.props.onClick as (() => void) | undefined)?.();
    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedList = componentElement(expandedPane, "LegendList");
    const expandedRows = expandedList.props.data as Array<{ readonly key: string }>;
    expect(expandedRows.map((row) => row.key)).toContain("refs/heads/feature/ui");
    const renderExpandedRow = expandedList.props.renderItem as (props: {
      readonly item: (typeof expandedRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const uiBranch = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/heads/feature/ui")!,
    });
    expect(
      visitElements(
        uiBranch,
        (element) => element.props.children === "10 commits ahead of origin/feature/ui",
      ),
    ).not.toBeNull();
    const developmentBranch = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/heads/development")!,
    });
    expect(
      visitElements(
        developmentBranch,
        (element) => element.props.children === "3 commits ahead of origin/development",
      ),
    ).not.toBeNull();
    const developmentButton = visitElements(
      developmentBranch,
      (element) =>
        element.props["aria-label"] ===
        "development. 3 commits ahead of upstream origin/development. 2 commits behind upstream origin/development.",
    );
    expect(developmentButton?.props["aria-label"]).toBe(
      "development. 3 commits ahead of upstream origin/development. 2 commits behind upstream origin/development.",
    );
    expect(
      visitElements(
        developmentBranch,
        (element) => element.props.children === "2 commits behind origin/development",
      ),
    ).not.toBeNull();
    const uiBranchButton = visitElements(
      uiBranch,
      (element) =>
        element.props["aria-label"] ===
        "feature/ui. 10 commits ahead of upstream origin/feature/ui.",
    );
    (uiBranchButton?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/heads/feature/ui",
      },
    });

    const filter = visitElements(
      expandedPane,
      (element) => element.props["aria-label"] === "Filter branches and tags",
    );
    (
      filter?.props.onChange as
        | ((event: { readonly target: { readonly value: string } }) => void)
        | undefined
    )?.({
      target: { value: "api" },
    });
    const filtered = renderPanel();
    const filteredPane = componentTree(filtered, "GitRefsPane");
    const filteredList = componentElement(filteredPane, "LegendList");
    const filteredRows = filteredList.props.data as Array<{ readonly key: string }>;
    expect(filteredRows.map((row) => row.key)).toContain("refs/heads/feature/api");
    expect(filteredRows.map((row) => row.key)).not.toContain("refs/heads/feature/ui");
  });

  it("lists and selects tags from the refs snapshot even when history has no tag decorations", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));
    historyState.tags = [gitRef("v1.2.3", { isTag: true })];

    const initial = renderPanel();
    const initialPane = componentTree(initial, "GitRefsPane");
    const initialList = componentElement(initialPane, "LegendList");
    const initialRows = initialList.props.data as Array<{ readonly key: string }>;
    const renderInitialRow = initialList.props.renderItem as (props: {
      readonly item: (typeof initialRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const tagsSectionRow = renderInitialRow({
      item: initialRows.find((row) => row.key === "section:tags")!,
    });
    const tagsSectionButton = visitElements(
      tagsSectionRow,
      (element) => element.props["aria-expanded"] === false,
    );
    (tagsSectionButton?.props.onClick as (() => void) | undefined)?.();

    const expanded = renderPanel();
    const expandedPane = componentTree(expanded, "GitRefsPane");
    const expandedList = componentElement(expandedPane, "LegendList");
    const expandedRows = expandedList.props.data as Array<{ readonly key: string }>;
    expect(expandedRows.map((row) => row.key)).toContain("refs/tags/v1.2.3");
    const renderExpandedRow = expandedList.props.renderItem as (props: {
      readonly item: (typeof expandedRows)[number];
    }) => ReactElement<Record<string, unknown>>;
    const tagRow = renderExpandedRow({
      item: expandedRows.find((row) => row.key === "refs/tags/v1.2.3")!,
    });
    const tagButton = visitElements(tagRow, (element) => element.props["aria-label"] === "v1.2.3");
    (tagButton?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getHistory).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        limit: historyPageSize,
        revision: "refs/tags/v1.2.3",
      },
    });
  });

  it("opens the full commit diff from selected commit details", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();

    const detailsPane = componentTree(renderPanel(), "CommitDetailsPane");
    const showDiff = visitElements(
      detailsPane,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("View all changes"),
    );
    expect(showDiff).not.toBeNull();
    (showDiff?.props.onClick as (() => void) | undefined)?.();

    renderPanel();
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
  });

  it("shows the short commit hash in every history row", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const shortHash = visitElements(
      historyRow,
      (element) => element.props.children === historyCommit.hash.slice(0, 8),
    );
    const shortHashTooltip = visitElements(
      historyRow,
      (element) => element.props.children === `Copy full commit hash ${historyCommit.hash}`,
    );

    expect(shortHash).not.toBeNull();
    expect(shortHash?.props["aria-label"]).toBe(`Copy commit hash ${historyCommit.hash}`);
    expect(shortHashTooltip).not.toBeNull();
  });

  it("shows an error toast when copying a history hash is rejected", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const copyHash = visitElements(
      historyRow,
      (element) => element.props["aria-label"] === `Copy commit hash ${historyCommit.hash}`,
    );
    (copyHash?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not copy commit hash",
      description: "Clipboard permission was denied.",
    });
  });

  it("gives every selectable commit its author, date, and parent topology", () => {
    const historyCommit = {
      ...commit(primaryCommitHash, "Merge release", "Grace Hopper"),
      parentHashes: ["parent-one", "parent-two"],
    };
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectableRow = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );

    expect(selectableRow?.props["aria-label"]).toContain("Author Grace Hopper");
    expect(selectableRow?.props["aria-label"]).toContain("2-parent merge commit");
  });

  it("refreshes history and every ref namespace", () => {
    historyState.pages.set(undefined, page([commit(primaryCommitHash, "Initial")]));

    const refresh = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Refresh Git history",
    );
    (refresh?.props.onClick as (() => void) | undefined)?.();

    expect(historyState.refreshRefs).toHaveBeenCalledOnce();
    expect(historyState.refreshRemoteRefs).toHaveBeenCalledOnce();
    expect(historyState.refreshTags).toHaveBeenCalledOnce();
  });

  it("links issue references to the active GitHub repository", () => {
    const historyCommit = commit(primaryCommitHash, "fix(repository): view (#602)");
    historyState.pages.set(undefined, page([historyCommit]));

    const list = historyList(renderPanel("https://github.com/VladsCoffeApp1/Argus/issues/"));
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const subject = componentTree(historyRow, "CommitSubject");
    const issueLink = visitElements(subject, (element) => element.props.children === "#602");

    expect(issueLink?.type).toBe("a");
    expect(issueLink?.props.href).toBe("https://github.com/VladsCoffeApp1/Argus/issues/602");
  });

  it("opens a changed file diff from selected commit details", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = {
      ...historyCommit,
      body: "",
    };
    historyState.diff = {
      diff: "diff --git a/src/panel.tsx b/src/panel.tsx\n+added line\n",
      isRepo: true,
      truncated: false,
    };

    const initial = renderPanel();
    const list = historyList(initial);
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();

    const details = renderPanel();
    const detailsPane = componentTree(details, "CommitDetailsPane");
    const fileTree = visitElements(
      detailsPane,
      (element) => typeof element.type === "function" && element.type.name === "CommitFilesTree",
    );
    expect(fileTree).not.toBeNull();
    expect(renderComponent(fileTree!).props.recycleItems).toBe(true);
    (fileTree?.props.onShowDiff as ((path: string) => void) | undefined)?.("src/panel.tsx");

    const diff = renderPanel();
    expect(historyState.getCommitDetails).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: { cwd: workspacePath, hash: historyCommit.hash },
    });
    expect(historyState.getCommitDiff).toHaveBeenLastCalledWith({
      cacheKey: 0,
      environmentId,
      input: {
        cwd: workspacePath,
        hash: historyCommit.hash,
        filePath: "src/panel.tsx",
      },
    });
    const diffView = visitElements(
      diff,
      (element) => typeof element.type === "function" && element.type.name === "CommitDiffView",
    );
    expect(diffView?.props).toMatchObject({ hash: historyCommit.hash, filePath: "src/panel.tsx" });
  });

  it("lets the diff load changed files beyond the first page", () => {
    const historyCommit = commit(primaryCommitHash, "Add panel");
    historyState.pages.set(undefined, page([historyCommit]));
    historyState.commitDetails = { ...historyCommit, body: "" };
    historyState.commitFiles = {
      files: [{ status: "A", path: "first.ts" }],
      isRepo: true,
      nextCursor: "files-page-2",
      hasMore: true,
      capped: false,
    };

    const list = historyList(renderPanel());
    const historyRow = renderComponent(list.props.renderItem({ item: list.props.data[0]! }));
    const selectCommit = visitElements(
      historyRow,
      (element) => element.props["data-commit-hash"] === historyCommit.hash,
    );
    (selectCommit?.props.onClick as (() => void) | undefined)?.();
    renderPanel();
    flushEffects();
    const detailsPane = componentElement(renderPanel(), "CommitDetailsPane");
    (detailsPane.props.onShowDiff as ((hash: string, filePath?: string) => void) | undefined)?.(
      historyCommit.hash,
    );

    const diffView = componentElement(renderPanel(), "CommitDiffView");
    expect(diffView.props).toMatchObject({ filesHasMore: true, filesLoading: false });
    const diff = renderComponent(diffView);
    const loadMore = visitElements(diff, (element) => element.props.children === "Load more files");

    expect(loadMore).not.toBeNull();
    expect(loadMore?.props.onClick).toBe(diffView.props.onLoadMoreFiles);
  });

  it("lets the diff retry a failed changed-file continuation", () => {
    const retryFiles = vi.fn();
    hooks.beginRender();
    const diff = CommitDiffView({
      hash: primaryCommitHash,
      files: [{ status: "A", path: "first.ts" }],
      filesError: true,
      filesHasMore: true,
      filesLoading: false,
      diff: null,
      truncated: false,
      isPending: false,
      error: null,
      onBack: vi.fn(),
      onSelectFile: vi.fn(),
      onRetry: vi.fn(),
      onLoadMoreFiles: vi.fn(),
      onRetryFiles: retryFiles,
    });
    const retry = visitElements(
      diff,
      (element) => element.props.children === "Retry loading files",
    );

    expect(retry).not.toBeNull();
    expect(retry?.props.onClick).toBe(retryFiles);
  });

  it("uses the returned changed-file cursor and accumulates its page", () => {
    const firstPage = [{ status: "A" as const, path: "first.ts" }];
    const secondPage = [{ status: "M" as const, path: "second.ts" }];

    expect(nextCommitFilesCursor("files-page-2")).toBe("files-page-2");
    expect(nextCommitFilesCursor(null)).toBeUndefined();
    expect(appendCommitFilesPage(firstPage, secondPage)).toEqual([
      { status: "A", path: "first.ts" },
      { status: "M", path: "second.ts" },
    ]);
  });
});
