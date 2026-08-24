import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";

describe("global Shift shortcut", () => {
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
});
