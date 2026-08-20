import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsPanel } from "./PullRequestsPanel";

const hooks = vi.hoisted(() => {
  let hookIndex = 0;
  const state = new Map<number, unknown>();
  const setters = new Map<number, (next: unknown) => void>();
  const effects = new Map<number, ReadonlyArray<unknown> | undefined>();
  const memos = new Map<
    number,
    { readonly dependencies: ReadonlyArray<unknown>; readonly value: unknown }
  >();

  return {
    beginRender: () => {
      hookIndex = 0;
    },
    reset: () => {
      hookIndex = 0;
      state.clear();
      setters.clear();
      effects.clear();
      memos.clear();
    },
    unmountFrom: (firstIndex: number) => {
      for (const index of state.keys()) {
        if (index >= firstIndex) state.delete(index);
      }
      for (const index of setters.keys()) {
        if (index >= firstIndex) setters.delete(index);
      }
      for (const index of effects.keys()) {
        if (index >= firstIndex) effects.delete(index);
      }
      for (const index of memos.keys()) {
        if (index >= firstIndex) memos.delete(index);
      }
    },
    useCallback: <T,>(callback: T) => {
      hookIndex += 1;
      return callback;
    },
    useEffect: (effect: () => void | (() => void), dependencies: ReadonlyArray<unknown>) => {
      const index = hookIndex++;
      const previous = effects.get(index);
      effects.set(index, dependencies);
      if (
        previous === undefined ||
        previous.length !== dependencies.length ||
        previous.some((value, dependencyIndex) => value !== dependencies[dependencyIndex])
      ) {
        effect();
      }
    },
    useMemo: <T,>(factory: () => T, dependencies: ReadonlyArray<unknown>) => {
      const index = hookIndex++;
      const previous = memos.get(index);
      if (
        previous !== undefined &&
        previous.dependencies.length === dependencies.length &&
        previous.dependencies.every(
          (value, dependencyIndex) => value === dependencies[dependencyIndex],
        )
      ) {
        return previous.value as T;
      }
      const value = factory();
      memos.set(index, { dependencies, value });
      return value;
    },
    useRef: <T,>(value: T) => {
      const index = hookIndex++;
      if (!state.has(index)) state.set(index, { current: value ?? ({} as T) });
      return state.get(index) as { current: T };
    },
    useState: <T,>(initial: T) => {
      const index = hookIndex++;
      if (!state.has(index)) {
        state.set(index, typeof initial === "function" ? (initial as () => T)() : initial);
      }
      if (!setters.has(index)) {
        setters.set(index, (next) => {
          state.set(
            index,
            typeof next === "function" ? (next as (previous: T) => T)(state.get(index) as T) : next,
          );
        });
      }
      return [
        state.get(index) as T,
        setters.get(index) as (next: T | ((previous: T) => T)) => void,
      ] as const;
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
  useMemo: hooks.useMemo,
  useRef: hooks.useRef,
  useState: hooks.useState,
}));

vi.mock("effect/Option", () => ({ getOrNull: <T,>(value: T) => value }));
vi.mock("effect/unstable/reactivity", () => ({
  AsyncResult: { value: (result: { readonly value: unknown }) => result.value },
}));

const queries = vi.hoisted(() => {
  const initial = {
    viewers: {},
    providers: [],
    entries: Array.from({ length: 30 }, (_, index) => ({
      host: "github.com",
      labels: [],
      number: index + 1,
      projectId: "project-1",
      repository: "owner/repository",
      state: "open",
      updatedAt: "2026-08-20T00:00:00.000Z",
    })),
    errors: [],
    truncated: true,
    nextCursors: { "github.com": "second-page" },
  };
  const continuation = {
    ...initial,
    entries: [{ ...initial.entries[0], number: 31 }],
    truncated: false,
    nextCursors: {},
  };
  return {
    inputs: [] as Array<{ readonly input: { readonly cursors?: unknown; readonly limit: number } }>,
    refresh: vi.fn(),
    initial,
    continuation,
  };
});

const stats = vi.hoisted(() => ({
  targets: [] as ReadonlyArray<unknown>[],
  value: [] as ReadonlyArray<unknown>,
  refresh: vi.fn(),
}));

const buttons = vi.hoisted(() => new Map<string, () => void>());
const observers = vi.hoisted(
  () => [] as Array<(entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void>,
);
const detailActions = vi.hoisted(() => [] as Array<() => void>);
const rowEntries = vi.hoisted(() => [] as Array<unknown>);

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    invalidate: {},
    list: (input: unknown) => input,
    listStats: (target: unknown) => {
      stats.targets.push([target]);
      return target;
    },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ value: { stats: stats.value } }),
    refresh: stats.refresh,
    subscribe: () => () => undefined,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("~/state/queries", () => ({
  useDebouncedValue: (value: string) => value,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: {
    readonly input: { readonly cursors?: unknown; readonly limit: number };
  }) => {
    queries.inputs.push(query);
    const continuation = query.input.cursors !== undefined;
    return {
      data: continuation ? queries.continuation : queries.initial,
      error: null,
      isPending: false,
      refresh: queries.refresh,
    };
  },
}));

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    "aria-label": ariaLabel,
    onClick,
  }: {
    children: ReactNode;
    "aria-label"?: string;
    onClick?: () => void;
  }) => {
    if (ariaLabel && onClick) buttons.set(ariaLabel, onClick);
    return <button type="button">{children}</button>;
  },
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./PullRequestListFilters", () => ({ PullRequestFiltersMenu: () => null }));
vi.mock("./PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({ onActed }: { onActed: () => void }) => {
    detailActions.push(onActed);
    return null;
  },
}));
vi.mock("./PullRequestRow", () => ({
  PullRequestRow: ({ entry }: { readonly entry: unknown }) => {
    rowEntries.push(entry);
    return null;
  },
}));

describe("PullRequestsPanel", () => {
  it("refreshes the accumulated list from the first page after cursor pagination", async () => {
    hooks.reset();
    queries.inputs.length = 0;
    queries.refresh.mockReset();
    stats.targets.length = 0;
    stats.value = [];
    buttons.clear();
    observers.length = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void,
        ) {
          observers.push(callback);
        }
        disconnect() {}
        observe() {}
      },
    );

    const render = () => {
      hooks.beginRender();
      renderToStaticMarkup(
        <PullRequestsPanel
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          selected={null}
          onSelect={() => undefined}
        />,
      );
    };

    render();
    observers.at(-1)?.([{ isIntersecting: true }]);
    render();
    render();
    expect(queries.inputs.at(-1)?.input.cursors).toEqual({ "github.com": "second-page" });

    buttons.get("Refresh pull requests")?.();
    await Promise.resolve();
    await Promise.resolve();
    render();

    expect(queries.inputs.at(-1)?.input).toMatchObject({ limit: 60 });
    expect(queries.inputs.at(-1)?.input.cursors).toBeUndefined();
  });

  it("refreshes line counts only for the current paged rows", async () => {
    hooks.reset();
    queries.inputs.length = 0;
    stats.targets.length = 0;
    stats.value = [];
    stats.refresh.mockReset();
    observers.length = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void,
        ) {
          observers.push(callback);
        }
        disconnect() {}
        observe() {}
      },
    );

    const render = () => {
      hooks.beginRender();
      renderToStaticMarkup(
        <PullRequestsPanel
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          selected={null}
          onSelect={() => undefined}
        />,
      );
    };

    render();
    render();
    expect(stats.targets.at(-1)).toEqual([
      {
        environmentId: "env-1",
        input: {
          refs: expect.arrayContaining([
            expect.objectContaining({ number: 1 }),
            expect.objectContaining({ number: 30 }),
          ]),
        },
      },
    ]);

    observers.at(-1)?.([{ isIntersecting: true }]);
    render();
    render();
    render();
    expect(stats.targets.at(-1)).toEqual([
      expect.objectContaining({
        input: {
          refs: expect.arrayContaining([
            expect.objectContaining({ number: 1 }),
            expect.objectContaining({ number: 31 }),
          ]),
        },
      }),
    ]);

    buttons.get("Refresh pull requests")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(stats.refresh).toHaveBeenCalledTimes(1);
    expect(
      (
        stats.targets.at(-1) as Array<{
          readonly input: { readonly refs: ReadonlyArray<unknown> };
        }>
      )[0]?.input.refs,
    ).toHaveLength(31);
  });

  it("unmounts the browser list while a pull request detail is selected", () => {
    hooks.reset();
    queries.inputs.length = 0;
    stats.targets.length = 0;
    stats.value = [];

    hooks.beginRender();
    renderToStaticMarkup(
      <PullRequestsPanel
        environmentId={"env-1" as never}
        projectId={"project-1" as never}
        selected={{ projectId: "project-1" as never, repository: "owner/repository", number: 1 }}
        onSelect={() => undefined}
      />,
    );

    expect(queries.inputs).toEqual([]);
    expect(stats.targets).toEqual([]);
  });

  it("keeps unchanged decorated row entries stable between panel renders", () => {
    hooks.reset();
    queries.inputs.length = 0;
    rowEntries.length = 0;
    stats.value = [
      { environmentId: "env-1", projectId: "project-1", number: 1, additions: 2, deletions: 1 },
    ];

    const render = () => {
      hooks.beginRender();
      renderToStaticMarkup(
        <PullRequestsPanel
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          selected={null}
          onSelect={() => undefined}
        />,
      );
    };

    render();
    render();
    render();

    expect(rowEntries.at(-30)).toBe(rowEntries.at(-60));
  });

  it("replays a detail action after the list remounts", () => {
    hooks.reset();
    queries.inputs.length = 0;
    queries.refresh.mockReset();
    stats.refresh.mockReset();
    stats.targets.length = 0;
    stats.value = [];
    buttons.clear();
    detailActions.length = 0;
    observers.length = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void,
        ) {
          observers.push(callback);
        }
        disconnect() {}
        observe() {}
      },
    );

    const render = (
      selected: {
        readonly projectId: never;
        readonly repository: string;
        readonly number: number;
      } | null,
    ) => {
      hooks.beginRender();
      renderToStaticMarkup(
        <PullRequestsPanel
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          selected={selected}
          onSelect={() => undefined}
        />,
      );
    };

    render(null);
    observers.at(-1)?.([{ isIntersecting: true }]);
    render(null);
    render({ projectId: "project-1" as never, repository: "owner/repository", number: 1 });
    detailActions.at(-1)?.();
    hooks.unmountFrom(6);
    render({ projectId: "project-1" as never, repository: "owner/repository", number: 1 });
    render({ projectId: "project-1" as never, repository: "owner/repository", number: 1 });
    render(null);
    render(null);

    expect(queries.inputs.at(-1)?.input).toMatchObject({ limit: 60 });
    expect(queries.inputs.at(-1)?.input.cursors).toBeUndefined();
    expect(queries.refresh).not.toHaveBeenCalled();
    expect(stats.refresh).toHaveBeenCalledTimes(1);
  });
});
