import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsPanel } from "./PullRequestsPanel";

const hooks = vi.hoisted(() => {
  let hookIndex = 0;
  const state = new Map<number, unknown>();
  const setters = new Map<number, (next: unknown) => void>();
  const effects = new Map<number, ReadonlyArray<unknown> | undefined>();
  const cleanups = new Map<number, () => void>();
  const deferredEffects = new Map<number, () => void | (() => void)>();
  let deferEffects = false;
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
      cleanups.clear();
      deferredEffects.clear();
      deferEffects = false;
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
        if (index >= firstIndex) {
          cleanups.get(index)?.();
          cleanups.delete(index);
          effects.delete(index);
        }
      }
      for (const index of memos.keys()) {
        if (index >= firstIndex) memos.delete(index);
      }
    },
    useCallback: <T,>(callback: T) => {
      hookIndex += 1;
      return callback;
    },
    deferEffects: () => {
      deferEffects = true;
    },
    flushEffects: () => {
      for (const [index, effect] of deferredEffects) {
        const cleanup = effect();
        if (cleanup) cleanups.set(index, cleanup);
      }
      deferredEffects.clear();
      deferEffects = false;
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
        cleanups.get(index)?.();
        cleanups.delete(index);
        if (deferEffects) deferredEffects.set(index, effect);
        else {
          const cleanup = effect();
          if (cleanup) cleanups.set(index, cleanup);
        }
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

const queries = vi.hoisted(() => {
  const initial = {
    viewers: {},
    providers: [],
    entries: Array.from({ length: 30 }, (_, index) => ({
      additions: 0,
      deletions: 0,
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

const stats = vi.hoisted(() => {
  const subscriptions: Array<{
    readonly atom: unknown;
    readonly callback: (result: unknown) => void;
    active: boolean;
  }> = [];
  return {
    targets: [] as ReadonlyArray<unknown>[],
    events: [] as string[],
    subscriptions,
    cleanups: [] as unknown[],
    refreshes: [] as unknown[],
    value: [] as ReadonlyArray<unknown>,
    emit: (atom: unknown, result: unknown) => {
      let emitted = 0;
      for (const subscription of subscriptions) {
        if (subscription.atom === atom && subscription.active) {
          subscription.callback(result);
          emitted += 1;
        }
      }
      return emitted;
    },
  };
});

const debounce = vi.hoisted(() => ({ value: null as string | null }));

const buttons = vi.hoisted(() => new Map<string, () => void>());
const inputs = vi.hoisted(() => new Map<string, (value: string) => void>());
const inputMaxLengths = vi.hoisted(() => new Map<string, number | undefined>());
const observers = vi.hoisted(
  () => [] as Array<(entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void>,
);
const detailActions = vi.hoisted(() => [] as Array<() => void>);
const detailTitleSaves = vi.hoisted(() => [] as Array<(() => void) | undefined>);
const rowEntries = vi.hoisted(() => [] as Array<unknown>);

vi.mock("~/state/pullRequests", () => ({
  usePullRequestListStats: (
    targets: ReadonlyArray<{ readonly environmentId: string; readonly input: unknown }>,
  ) => {
    const [results, setResults] = hooks.useState<ReadonlyMap<number, unknown>>(new Map());
    hooks.useEffect(() => {
      const subscriptions = targets.map((target, index) => {
        stats.targets.push([target]);
        const atom = target;
        const update = (result: unknown) => {
          const value =
            typeof result === "object" && result !== null && "stats" in result
              ? (result.stats as ReadonlyArray<unknown> | undefined)
              : undefined;
          setResults((previous) => {
            const next = new Map(previous);
            next.set(index, value ?? []);
            return next;
          });
        };
        stats.events.push("subscribe");
        const subscription = { atom, callback: update, active: true };
        stats.subscriptions.push(subscription);
        stats.events.push("read");
        update({ stats: stats.value });
        return () => {
          subscription.active = false;
          stats.cleanups.push(atom);
        };
      });
      return () => {
        for (const unsubscribe of subscriptions) unsubscribe();
      };
    }, [targets]);
    const merged = [...results.entries()].flatMap(([index, value]) =>
      (value as ReadonlyArray<Record<string, unknown>>).map((stat) => ({
        ...stat,
        environmentId: targets[index]?.environmentId,
      })),
    );
    return {
      stats: merged.length === 0 ? null : merged,
      refresh: () => {
        for (const target of targets) stats.refreshes.push(target);
      },
    };
  },
  pullRequestEnvironment: {
    invalidate: {},
    list: (input: unknown) => input,
    listStats: (input: unknown) => {
      stats.targets.push([input]);
      return input;
    },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (_atom: unknown) => {
      stats.events.push("read");
      return { stats: stats.value };
    },
    subscribe: (atom: unknown, callback: (result: unknown) => void) => {
      stats.events.push("subscribe");
      const subscription = { atom, callback, active: true };
      stats.subscriptions.push(subscription);
      return () => {
        subscription.active = false;
        stats.cleanups.push(atom);
      };
    },
    refresh: (atom: unknown) => stats.refreshes.push(atom),
  },
}));

vi.mock("effect/Option", () => ({ getOrNull: <T,>(value: T) => value }));
vi.mock("effect/unstable/reactivity", () => ({ AsyncResult: { value: <T,>(value: T) => value } }));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("~/state/queries", () => ({
  useDebouncedValue: (value: string) => debounce.value ?? value,
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

vi.mock("../ui/input", () => ({
  Input: ({
    "aria-label": ariaLabel,
    maxLength,
    onChange,
  }: {
    "aria-label"?: string;
    maxLength?: number;
    onChange?: (event: { readonly target: { readonly value: string } }) => void;
  }) => {
    if (ariaLabel && onChange) {
      inputs.set(ariaLabel, (value) => onChange({ target: { value } }));
      inputMaxLengths.set(ariaLabel, maxLength);
    }
    return <input />;
  },
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./PullRequestListFilters", () => ({ PullRequestFiltersMenu: () => null }));
vi.mock("./PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({
    onActed,
    onTitleSaved,
  }: {
    onActed: () => void;
    onTitleSaved?: () => void;
  }) => {
    detailActions.push(onActed);
    detailTitleSaves.push(onTitleSaved);
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
  it("subscribes to line-count atoms only after the panel render", () => {
    hooks.reset();
    stats.events.length = 0;
    stats.subscriptions.length = 0;
    stats.cleanups.length = 0;
    stats.refreshes.length = 0;
    stats.targets.length = 0;
    stats.value = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
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

    hooks.deferEffects();
    render();
    expect(stats.events).toEqual([]);
    hooks.flushEffects();

    expect(stats.events).toEqual(["subscribe", "read"]);
    expect(stats.subscriptions.map((subscription) => subscription.atom)).toEqual(
      stats.targets.at(-1),
    );
  });

  it("merges later stats emissions and ignores emissions after target cleanup", () => {
    hooks.reset();
    stats.events.length = 0;
    stats.subscriptions.length = 0;
    stats.cleanups.length = 0;
    stats.refreshes.length = 0;
    stats.targets.length = 0;
    stats.value = [];
    rowEntries.length = 0;
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
    const initialAtom = stats.subscriptions[0]?.atom;
    if (initialAtom === undefined) throw new Error("Expected initial stats subscription.");
    expect(
      stats.emit(initialAtom, {
        stats: [
          {
            projectId: "project-1",
            repository: "owner/repository",
            number: 1,
            additions: 5,
            deletions: 2,
          },
        ],
      }),
    ).toBe(1);
    render();
    render();

    const updatedEntry = rowEntries
      .filter(
        (entry): entry is { readonly number: number; readonly additions?: number } =>
          typeof entry === "object" && entry !== null && "number" in entry,
      )
      .findLast((entry) => entry.number === 1);
    expect(updatedEntry).toMatchObject({ additions: 5, deletions: 2, environmentId: "env-1" });

    observers.at(-1)?.([{ isIntersecting: true }]);
    render();
    render();
    stats.emit(initialAtom, {
      stats: [
        {
          projectId: "project-1",
          repository: "owner/repository",
          number: 1,
          additions: 99,
          deletions: 99,
        },
      ],
    });
    render();

    const entryAfterCleanup = rowEntries
      .filter(
        (entry): entry is { readonly number: number; readonly additions?: number } =>
          typeof entry === "object" && entry !== null && "number" in entry,
      )
      .findLast((entry) => entry.number === 1);
    expect(stats.cleanups).toContain(initialAtom);
    expect(entryAfterCleanup).toMatchObject({ additions: 5, deletions: 2 });
  });

  it("replaces line-count subscriptions when paged targets change", () => {
    hooks.reset();
    stats.events.length = 0;
    stats.subscriptions.length = 0;
    stats.cleanups.length = 0;
    stats.refreshes.length = 0;
    stats.value = [];
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
    const initialAtom = stats.subscriptions[0]?.atom;
    if (initialAtom === undefined) throw new Error("Expected initial stats subscription.");
    observers.at(-1)?.([{ isIntersecting: true }]);
    render();
    render();

    expect(stats.cleanups).toContain(initialAtom);
    expect(
      stats.subscriptions.find((subscription) => subscription.atom === initialAtom)?.active,
    ).toBe(false);
  });

  it("refreshes each current line-count atom once per refresh generation", async () => {
    hooks.reset();
    stats.events.length = 0;
    stats.subscriptions.length = 0;
    stats.cleanups.length = 0;
    stats.refreshes.length = 0;
    stats.value = [];
    buttons.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
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
    buttons.get("Refresh pull requests")?.();
    await Promise.resolve();
    await Promise.resolve();
    render();
    render();

    expect(stats.refreshes).toEqual(
      stats.subscriptions.slice(-1).map((subscription) => subscription.atom),
    );
  });

  it("caps compact pull request searches at the host query limit", () => {
    hooks.reset();
    inputMaxLengths.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        disconnect() {}
        observe() {}
      },
    );

    hooks.beginRender();
    renderToStaticMarkup(
      <PullRequestsPanel
        environmentId={"env-1" as never}
        projectId={"project-1" as never}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(inputMaxLengths.get("Search pull requests")).toBe(200);
  });

  it("unmounts line-count stats while a compact search is typed then cleared", () => {
    hooks.reset();
    stats.targets.length = 0;
    stats.value = [];
    debounce.value = null;
    inputs.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
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
    const settledTargetCount = stats.targets.length;
    debounce.value = "";
    inputs.get("Search pull requests")?.("x".repeat(200));
    render();
    expect(stats.targets).toHaveLength(settledTargetCount);

    inputs.get("Search pull requests")?.("");
    render();

    expect(stats.targets).toHaveLength(settledTargetCount + 1);
    debounce.value = null;
  });

  it("does not refresh line-count stats after a refresh occurs while compact search targets are empty", async () => {
    hooks.reset();
    stats.targets.length = 0;
    stats.value = [];
    stats.refreshes.length = 0;
    debounce.value = null;
    inputs.clear();
    buttons.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
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
    debounce.value = "";
    inputs.get("Search pull requests")?.("x".repeat(200));
    render();
    hooks.unmountFrom(28);

    buttons.get("Refresh pull requests")?.();
    await Promise.resolve();
    await Promise.resolve();
    render();

    inputs.get("Search pull requests")?.("");
    render();

    expect(stats.refreshes).toHaveLength(0);
    debounce.value = null;
  });

  it("does not refresh line-count stats again after targets remount without another refresh", async () => {
    hooks.reset();
    stats.targets.length = 0;
    stats.value = [];
    stats.refreshes.length = 0;
    debounce.value = null;
    inputs.clear();
    buttons.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
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
    buttons.get("Refresh pull requests")?.();
    await Promise.resolve();
    await Promise.resolve();
    render();
    expect(stats.refreshes).toHaveLength(1);

    debounce.value = "";
    inputs.get("Search pull requests")?.("x".repeat(200));
    render();
    hooks.unmountFrom(28);
    inputs.get("Search pull requests")?.("");
    render();

    expect(stats.refreshes).toHaveLength(1);
    debounce.value = null;
  });

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
    stats.refreshes.length = 0;
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
    render();

    expect(stats.refreshes).toHaveLength(1);
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
    render();

    expect(rowEntries.at(-30)).toBe(rowEntries.at(-60));
  });

  it("replays a detail action after the list remounts", () => {
    hooks.reset();
    queries.inputs.length = 0;
    queries.refresh.mockReset();
    stats.refreshes.length = 0;
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
    expect(stats.refreshes).toHaveLength(1);
  });

  it("replays a saved title after the list remounts", () => {
    hooks.reset();
    queries.inputs.length = 0;
    queries.refresh.mockReset();
    stats.refreshes.length = 0;
    stats.targets.length = 0;
    stats.value = [];
    detailTitleSaves.length = 0;
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
    detailTitleSaves.at(-1)?.();
    hooks.unmountFrom(6);
    render({ projectId: "project-1" as never, repository: "owner/repository", number: 1 });
    render({ projectId: "project-1" as never, repository: "owner/repository", number: 1 });
    render(null);
    render(null);

    expect(queries.inputs.at(-1)?.input).toMatchObject({ limit: 60 });
    expect(queries.inputs.at(-1)?.input.cursors).toBeUndefined();
    expect(queries.refresh).not.toHaveBeenCalled();
    expect(stats.refreshes).toHaveLength(1);
  });
});
