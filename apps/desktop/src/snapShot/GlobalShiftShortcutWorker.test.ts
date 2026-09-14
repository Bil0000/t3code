import { afterEach, expect, it, vi } from "vite-plus/test";

const held = vi.hoisted(() => new Set<number>());
vi.mock("../electron/WindowsForeground.ts", () => ({
  loadWindowsForegroundApi: async () => ({ isKeyDown: (key: number) => held.has(key) }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("fires once per press for either Windows pair, preserves sides, and stops on disconnect", async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const exit = vi.fn();
  const once = vi.fn();
  vi.stubGlobal("process", {
    ...process,
    argv: ["node", "worker", '[["MetaLeft","MetaRight"],["MetaLeft","ControlRight"]]'],
    send,
    exit,
    once,
  });
  await import("./GlobalShiftShortcutWorker.ts");
  expect(send).toHaveBeenCalledWith("ready");
  held.clear();
  held.add(0x5b);
  held.add(0xa2);
  await vi.advanceTimersByTimeAsync(50);
  expect(send.mock.calls.filter(([message]) => message === "trigger")).toHaveLength(0);
  held.delete(0xa2);
  held.add(0xa3);
  await vi.advanceTimersByTimeAsync(150);
  expect(send.mock.calls.filter(([message]) => message === "trigger")).toHaveLength(1);
  held.add(0x5c);
  await vi.advanceTimersByTimeAsync(150);
  expect(send.mock.calls.filter(([message]) => message === "trigger")).toHaveLength(2);
  held.clear();
  await vi.advanceTimersByTimeAsync(50);
  held.add(0x5b);
  held.add(0x5c);
  await vi.advanceTimersByTimeAsync(50);
  expect(send.mock.calls.filter(([message]) => message === "trigger")).toHaveLength(3);
  once.mock.calls.find(([event]) => event === "disconnect")![1]();
  expect(vi.getTimerCount()).toBe(0);
  expect(exit).toHaveBeenCalledWith(0);
});
