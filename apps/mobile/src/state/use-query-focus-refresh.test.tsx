// @vitest-environment jsdom
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({ focus: () => {} }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (focus: () => void) => {
      useEffect(() => {
        navigation.focus = focus;
        focus();
      }, [focus]);
    },
  };
});

import { useQueryFocusRefresh } from "./use-query-focus-refresh";
import { usePullToRefresh } from "./use-pull-to-refresh";

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let reads: number;
let resolve: (value: number) => void;
let displayed: number | null;
let pullToRefresh: () => void;
const query = () =>
  Atom.make(
    Effect.promise(() => {
      reads++;
      return new Promise<number>((complete) => {
        resolve = complete;
      });
    }),
  ).pipe(Atom.swr({ staleTime: 60_000, revalidateOnMount: true }), Atom.setIdleTTL(60_000));

function Probe({ atom }: { atom: ReturnType<typeof query> }) {
  const result = useAtomValue(atom);
  useQueryFocusRefresh(atom);
  const pullRefresh = usePullToRefresh(atom);
  useEffect(() => {
    displayed = result._tag === "Success" ? result.value : null;
    pullToRefresh = pullRefresh.onRefresh;
  }, [pullRefresh.onRefresh, result]);
  return null;
}

const mount = (atom: ReturnType<typeof query>) =>
  act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe atom={atom} />
      </RegistryContext.Provider>,
    );
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  root = createRoot(document.createElement("div"));
  reads = 0;
  displayed = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("joins the initial PR read and refreshes after returning or changing PRs", async () => {
  await mount(query());
  expect(reads).toBe(1);
  await act(async () => resolve(1));
  expect(displayed).toBe(1);
  await act(async () => navigation.focus());
  expect(reads).toBe(2);
  await act(async () => resolve(2));
  expect(displayed).toBe(2);
  await mount(query());
  expect(reads).toBe(3);
  await act(async () => resolve(3));
  expect(displayed).toBe(3);
});

it("refreshes settled cached detail on first focus for current review permissions and head", async () => {
  const atom = query();
  const unmount = registry.mount(atom);
  await act(async () => resolve(1));
  expect(reads).toBe(1);
  await mount(atom);
  expect(reads).toBe(2);
  await act(async () => resolve(2));
  expect(displayed).toBe(2);
  unmount();
});

it("keeps pull to refresh available after joining the mount read", async () => {
  await mount(query());
  await act(async () => resolve(1));
  await act(async () => pullToRefresh());
  expect(reads).toBe(2);
  await act(async () => resolve(2));
  expect(displayed).toBe(2);
});
