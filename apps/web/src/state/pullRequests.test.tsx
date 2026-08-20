import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePullRequestListStats } from "./pullRequests";

const stats = vi.hoisted(() => {
  const subscriptions: Array<{
    readonly atom: unknown;
    readonly callback: (result: unknown) => void;
  }> = [];
  return {
    events: [] as string[],
    refreshes: [] as unknown[],
    subscriptions,
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("@t3tools/client-runtime/state/pull-requests", () => ({
  createPullRequestEnvironmentAtoms: () => ({
    list: () => ({}),
    listStats: (target: unknown) => target,
  }),
}));

vi.mock("effect/Option", () => ({ getOrNull: <T,>(value: T) => value }));
vi.mock("effect/unstable/reactivity", () => ({
  AsyncResult: { value: (result: { readonly value?: unknown }) => result.value ?? null },
  Atom: {
    family: () => () => ({}),
    make: () => ({ pipe: () => ({}) }),
    withLabel: () => (atom: unknown) => atom,
  },
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./query", () => ({ formatEnvironmentQueryError: () => "Query failed" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => {
      stats.events.push("read");
      return { value: { stats: [] }, atom };
    },
    subscribe: (atom: unknown, callback: (result: unknown) => void) => {
      stats.events.push("subscribe");
      stats.subscriptions.push({ atom, callback });
      return () => undefined;
    },
    refresh: (atom: unknown) => stats.refreshes.push(atom),
  },
}));

function render(
  targets: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly input: unknown }>,
) {
  hooks.beginRender();
  return usePullRequestListStats(targets as never);
}

describe("usePullRequestListStats", () => {
  beforeEach(() => {
    hooks.reset();
    stats.events.length = 0;
    stats.refreshes.length = 0;
    stats.subscriptions.length = 0;
  });

  it("subscribes before reading every stats atom and refreshes only those atoms", () => {
    const targets = [
      {
        environmentId: "environment-1" as EnvironmentId,
        input: { refs: [{ projectId: "project-1", repository: "owner/repository", number: 1 }] },
      },
    ] as const;

    const initial = render(targets);

    expect(initial.stats).toBeNull();
    expect(stats.events).toEqual(["subscribe", "read"]);

    initial.refresh();

    expect(stats.refreshes).toEqual(stats.subscriptions.map((subscription) => subscription.atom));
  });
});
