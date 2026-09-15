import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  presentations: new Map(),
  refreshProviders: vi.fn(),
  autoRefresh: async () => {},
  refreshingRef: { current: false },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) {
      state.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
      },
    ];
  },
  useRef: () => state.refreshingRef,
  useEffect: () => {},
  useEffectEvent: (callback: () => Promise<void>) => {
    state.autoRefresh = callback;
    return callback;
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("react-native", () => ({ Alert: {}, Pressable: "button", View: "div" }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./usageProviders", () => ({ useProviderColors: () => ({}) }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refreshProviders }));

import { useRefreshLimits } from "./UsageLimitsSection";

it("keeps a newer environment failure when an older refresh finishes", async () => {
  const a = EnvironmentId.make("mobile-limits-a");
  const b = EnvironmentId.make("mobile-limits-b");
  const pending = Promise.withResolvers<{ _tag: string }>();
  const read = () => {
    state.cursor = 0;
    return useRefreshLimits();
  };
  const presentation = (label: string) => ({
    connection: { phase: "connected" },
    entry: { target: { label } },
  });
  state.presentations = new Map([[a, presentation("A")]]);
  state.refreshProviders.mockImplementation(({ environmentId }) =>
    environmentId === a ? pending.promise : Promise.resolve({ _tag: "Failure" }),
  );
  const first = read().refresh();
  state.presentations = new Map([
    [a, presentation("A")],
    [b, presentation("B")],
  ]);
  read();
  await state.autoRefresh();
  expect(read().failedLabels).toEqual(["B"]);
  pending.resolve({ _tag: "Success" });
  await first;
  expect(read().failedLabels).toEqual(["B"]);
});
