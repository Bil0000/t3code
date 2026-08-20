import {
  VcsSnapshotExpiredError,
  type EnvironmentId,
  type VcsListRefsResult,
  type VcsListHistoryRefsResult,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePaginatedBranches, usePaginatedHistoryRefs } from "./queries";

type PageResult =
  | {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: VcsListHistoryRefsResult;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: Error;
      readonly waiting: false;
    };

type PageAtom = {
  readonly input: {
    readonly cursor?: string;
    readonly queryGeneration: number;
    readonly refresh?: true;
  };
  readonly result: PageResult;
};

const refsState = vi.hoisted(() => ({
  atoms: [] as PageAtom[],
  branchAtoms: [] as Array<{ readonly input: { readonly cursor?: number } }>,
  branchResults: new Map<string, VcsListRefsResult>(),
  connection: { phase: "connected", generation: 1 },
  refresh: vi.fn(),
  results: new Map<string, PageResult>(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => effect(),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly value: ReadonlyArray<PageResult> }) => atom.value,
}));

vi.mock("effect/Cause", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Cause")>();
  return { ...actual, squash: (cause: Error) => cause };
});

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    AsyncResult: {
      ...actual.AsyncResult,
      value: (result: PageResult) =>
        result._tag === "Success" ? { _tag: "Some", value: result.value } : { _tag: "None" },
    },
    Atom: {
      ...actual.Atom,
      make: (create: unknown) => {
        if (typeof create !== "function") return actual.Atom.make(create);
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

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: refsState.refresh },
}));

vi.mock("@t3tools/client-runtime/state/thread-search", () => ({
  createThreadSearchResultsAtomFamily: () => () => ({}),
  makeThreadSearchKey: () => "",
}));

vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./projects", () => ({ projectContentSearch: {}, projectEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: { readonly state?: { readonly data: unknown } } | null) =>
    atom?.state ?? { data: null },
}));
vi.mock("./threads", () => ({ useEnvironmentThread: () => ({}) }));

vi.mock("./vcs", () => ({
  vcsEnvironment: {
    listHistoryRefs: ({ input }: { readonly input: PageAtom["input"] }) => {
      const result = refsState.results.get(`${input.queryGeneration}:${input.cursor ?? "first"}`);
      if (result === undefined)
        throw new Error(`Missing result for ${input.queryGeneration}:${input.cursor ?? "first"}`);
      const atom = { input, result };
      refsState.atoms.push(atom);
      return atom;
    },
    listRefs: ({ input }: { readonly input: { readonly cursor?: number } }) => {
      const result = refsState.branchResults.get(`${input.cursor ?? "first"}`);
      if (result === undefined) throw new Error(`Missing result for ${input.cursor ?? "first"}`);
      const atom = { input, result: { _tag: "Success" as const, waiting: false, value: result } };
      refsState.branchAtoms.push(atom);
      return atom;
    },
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => ({ state: { data: refsState.connection } }) },
}));

const target = {
  environmentId: "environment" as EnvironmentId,
  cwd: "C:/workspace",
  query: "",
};

function page(nextCursor: string | null): PageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor,
      currentRef: null,
      isComplete: true,
    },
  };
}

function render(revision = 0, queryTarget = target) {
  hooks.beginRender();
  return usePaginatedHistoryRefs(queryTarget, { revision });
}

function renderBranches() {
  hooks.beginRender();
  return usePaginatedBranches(target);
}

describe("usePaginatedHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    refsState.atoms = [];
    refsState.branchAtoms = [];
    refsState.branchResults.clear();
    refsState.connection = { phase: "connected", generation: 1 };
    refsState.refresh.mockReset();
    refsState.results.clear();
  });

  it("uses refresh only for the first page of a refreshed ref snapshot", () => {
    refsState.results.set("0:first", page("cursor-4"));
    refsState.results.set("1:first", page("cursor-8"));
    refsState.results.set("1:cursor-8", page(null));

    const initial = render();
    initial.refresh();
    const refreshed = render();
    refreshed.loadNext();
    render();
    render(0, { ...target, query: "later" });
    render();

    expect(refsState.atoms.map((atom) => atom.input)).toEqual([
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 0 },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 1, refresh: true },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 1, refresh: true },
      {
        cwd: "C:/workspace",
        cursor: "cursor-8",
        limit: 100,
        namespace: "local",
        queryGeneration: 1,
      },
      {
        cwd: "C:/workspace",
        limit: 100,
        namespace: "local",
        query: "later",
        queryGeneration: 1,
      },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 1 },
      {
        cwd: "C:/workspace",
        cursor: "cursor-8",
        limit: 100,
        namespace: "local",
        queryGeneration: 1,
      },
    ]);
    expect(
      new Set(
        refsState.atoms
          .filter((atom) => atom.input.refresh === true)
          .map(
            (atom) =>
              `${atom.input.cwd}:${atom.input.query ?? ""}:${atom.input.cursor ?? ""}:${atom.input.queryGeneration}`,
          ),
      ),
    ).toEqual(new Set(["C:/workspace:::1"]));
  });

  it("discards history cursor pages when the root reconnects", () => {
    refsState.results.set("0:first", page("cursor-4"));
    refsState.results.set("0:cursor-4", page(null));

    const initial = render();
    initial.loadNext();
    render();
    refsState.connection = { phase: "connected", generation: 2 };
    const reconnected = render();

    expect(refsState.atoms.map((atom) => atom.input.cursor)).toEqual([
      undefined,
      undefined,
      "cursor-4",
      undefined,
    ]);
    expect(reconnected.data?.nextCursor).toBe("cursor-4");
  });

  it("restarts from the first history refs page once when its repository revision changes", () => {
    refsState.results.set("0:first", page("cursor-4"));
    refsState.results.set("0:cursor-4", page(null));
    refsState.results.set("1:first", page(null));

    const initial = render();
    initial.loadNext();
    render();
    render(1);

    expect(refsState.atoms.map((atom) => atom.input)).toEqual([
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 0 },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 0 },
      {
        cwd: "C:/workspace",
        cursor: "cursor-4",
        limit: 100,
        namespace: "local",
        queryGeneration: 0,
      },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 1 },
    ]);
  });

  it("discards ref cursor pages when the root reconnects", () => {
    refsState.branchResults.set("first", {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: 4,
      totalCount: 2,
    });
    refsState.branchResults.set("4", {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: null,
      totalCount: 2,
    });

    const initial = renderBranches();
    initial.loadNext();
    renderBranches();
    refsState.connection = { phase: "connected", generation: 2 };
    renderBranches();

    expect(refsState.branchAtoms.map((atom) => atom.input.cursor)).toEqual([
      undefined,
      undefined,
      4,
      undefined,
    ]);
  });

  it("retries the failed appended page without duplicating its cursor", () => {
    refsState.results.set("0:first", page("cursor-4"));
    refsState.results.set("0:cursor-4", {
      _tag: "Failure",
      cause: new Error("temporary failure"),
      waiting: false,
    });

    const initial = render();
    initial.loadNext();
    const withFailedPage = render();
    withFailedPage.loadNext();
    withFailedPage.retry();

    expect(refsState.atoms.map((atom) => atom.input.cursor)).toEqual([
      undefined,
      undefined,
      "cursor-4",
    ]);
    expect(refsState.refresh).toHaveBeenCalledTimes(1);
    expect(refsState.refresh).toHaveBeenCalledWith(refsState.atoms.at(-1));
  });

  it("recovers an expired snapshot once per generation, including after a later refresh", () => {
    const expired = (cursor: string) =>
      new VcsSnapshotExpiredError({ operation: "GitVcsDriver.listHistoryRefs", cursor });
    refsState.results.set("0:first", { _tag: "Failure", cause: expired("first"), waiting: false });
    refsState.results.set("1:first", page(null));

    render();
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1]);

    const recovered = render();
    recovered.refresh();
    refsState.results.set("2:first", { _tag: "Failure", cause: expired("second"), waiting: false });
    refsState.results.set("3:first", page(null));
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1, 2, 3]);
  });
});
