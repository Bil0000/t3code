import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";

describe("global Shift shortcut", () => {
  it("contains trigger errors at the native callback boundary", () => {
    const hook = Object.assign(new NodeEvents.EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    startGlobalShiftShortcut(hook, () => {
      throw new Error("capture failed synchronously");
    });

    expect(() => {
      hook.emit("keydown", { keycode: 42 });
      hook.emit("keydown", { keycode: 54 });
    }).not.toThrow();
  });

  it("fires once for both Shift keys and removes the hook on stop", () => {
    const hook = Object.assign(new NodeEvents.EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    const onTrigger = vi.fn();
    const stop = startGlobalShiftShortcut(hook, onTrigger);

    hook.emit("keydown", { keycode: 42 });
    hook.emit("keydown", { keycode: 54 });
    hook.emit("keydown", { keycode: 54 });
    expect(onTrigger).toHaveBeenCalledOnce();

    stop();
    expect(hook.stop).toHaveBeenCalledOnce();
    hook.emit("keyup", { keycode: 42 });
    hook.emit("keydown", { keycode: 42 });
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("fires for a Command pair hold and ignores Shift keys", () => {
    const hook = Object.assign(new NodeEvents.EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    const onTrigger = vi.fn();
    startGlobalShiftShortcut(hook, onTrigger, "meta");

    hook.emit("keydown", { keycode: 3_675, time: 1_000 });
    hook.emit("keydown", { keycode: 3_676, time: 1_050 });
    expect(onTrigger).toHaveBeenCalledOnce();

    hook.emit("keyup", { keycode: 3_675, time: 1_100 });
    hook.emit("keyup", { keycode: 3_676, time: 1_120 });
    hook.emit("keydown", { keycode: 42, time: 2_000 });
    hook.emit("keydown", { keycode: 54, time: 2_050 });
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("does not fire when the pair keys are pressed one after the other", () => {
    const hook = Object.assign(new NodeEvents.EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    const onTrigger = vi.fn();
    startGlobalShiftShortcut(hook, onTrigger);

    hook.emit("keydown", { keycode: 42, time: 1_000 });
    hook.emit("keyup", { keycode: 42, time: 1_040 });
    hook.emit("keydown", { keycode: 54, time: 1_250 });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
