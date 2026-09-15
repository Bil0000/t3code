import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { KeybindingCommand } from "@t3tools/contracts";
import {
  createShortcutPressTracker,
  installShortcutInput,
  mouseShortcutEvent,
  SHORTCUT_PRESS_WINDOW_MS,
} from "./shortcutInput";
import {
  parseKeybindingShortcut,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { formatShortcutLabel, resolveShortcutCommand } from "./keybindings";

const commands = new Map<number, KeybindingCommand>([
  [1, "thread.next"],
  [2, "usage.openLimits"],
  [3, "thread.previous"],
]);

describe("shortcut presses", () => {
  afterEach(() => vi.useRealTimers());
  it("rejects empty shortcuts and keeps the plus key", () => {
    expect(parseKeybindingShortcut("")).toBeNull();
    expect(parseKeybindingShortcut("  ")).toBeNull();
    expect(parseKeybindingShortcut("+")?.key).toBe("+");
  });
  it.each([1, 2, 3])("runs only the action for %i presses", (count) => {
    vi.useFakeTimers();
    const tracker = createShortcutPressTracker();
    const run = vi.fn();
    for (let i = 0; i < count; i++) {
      tracker.press("mouse5", commands, run);
      if (i < 2) expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(SHORTCUT_PRESS_WINDOW_MS);
    expect(run.mock.calls).toEqual([[commands.get(count)]]);
  });
  it("runs a single-only binding at once and a double at once if there is no triple", () => {
    const tracker = createShortcutPressTracker();
    const run = vi.fn();
    tracker.press("mouse4", new Map([[1, "thread.previous"]]), run);
    expect(run).toHaveBeenCalledWith("thread.previous");
    run.mockClear();
    const pair = new Map<number, KeybindingCommand>([
      [1, "thread.next"],
      [2, "usage.openLimits"],
    ]);
    tracker.press("mouse5", pair, run);
    expect(run).not.toHaveBeenCalled();
    tracker.press("mouse5", pair, run);
    expect(run.mock.calls).toEqual([["usage.openLimits"]]);
  });
  it("resets the gap after each press and does not fall back to a shorter match", () => {
    vi.useFakeTimers();
    const tracker = createShortcutPressTracker();
    const run = vi.fn();
    const sparse = new Map<number, KeybindingCommand>([
      [1, "thread.next"],
      [3, "thread.previous"],
    ]);
    tracker.press("mouse5", sparse, run);
    vi.advanceTimersByTime(SHORTCUT_PRESS_WINDOW_MS - 1);
    tracker.press("mouse5", sparse, run);
    vi.advanceTimersByTime(SHORTCUT_PRESS_WINDOW_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("starts a new sequence after the gap and clears pending presses on cancellation", () => {
    vi.useFakeTimers();
    const tracker = createShortcutPressTracker();
    const run = vi.fn();
    tracker.press("mouse5", commands, run);
    vi.advanceTimersByTime(SHORTCUT_PRESS_WINDOW_MS);
    tracker.press("mouse5", commands, run);
    tracker.clear();
    vi.runAllTimers();
    expect(run.mock.calls).toEqual([["thread.next"]]);
    tracker.press("mouse5", commands, run);
    vi.runAllTimers();
    expect(run.mock.calls).toEqual([["thread.next"], ["thread.next"]]);
  });
  it("keeps inputs and modifiers in separate sequences", () => {
    vi.useFakeTimers();
    const tracker = createShortcutPressTracker();
    const run = vi.fn();
    tracker.press("mouse5", commands, run);
    tracker.press("ctrl+mouse5", commands, run);
    vi.runAllTimers();
    expect(run.mock.calls).toEqual([["thread.next"], ["thread.next"]]);
  });
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "matches mouse and keyboard bindings together on %s",
    (platform) => {
      const config = compileResolvedKeybindingsConfig([
        { key: "mod+shift+]", command: "thread.next" },
        { key: "mouse5", command: "thread.next" },
        { key: "mouse5", presses: 2, command: "usage.openLimits" },
        { key: "mod+mouse4", presses: 3, command: "thread.previous" },
      ]);
      const base = mouseShortcutEvent({
        button: 4,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      });
      expect(resolveShortcutCommand(base, config, { platform })).toBe("thread.next");
      expect(resolveShortcutCommand({ ...base, presses: 2 }, config, { platform })).toBe(
        "usage.openLimits",
      );
      const mod = { metaKey: platform === "MacIntel", ctrlKey: platform !== "MacIntel" };
      expect(
        resolveShortcutCommand({ ...base, ...mod, key: "]", shiftKey: true }, config, { platform }),
      ).toBe("thread.next");
      expect(
        resolveShortcutCommand({ ...base, ...mod, key: "mouse4", presses: 3 }, config, {
          platform,
        }),
      ).toBe("thread.previous");
      expect(formatShortcutLabel(config[2]!.shortcut, platform)).toBe("Mouse Forward ×2");
    },
  );
});

describe("shortcut input dispatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reaches actions before editors consume keys and leaves unhandled shortcuts alone", () => {
    class InputEvent extends Event {
      constructor(
        type: string,
        readonly input: KeyboardEventInit = {},
      ) {
        super(type, input);
      }
      get key() {
        return this.input.key ?? "";
      }
      get code() {
        return this.input.code ?? "";
      }
      get metaKey() {
        return this.input.metaKey ?? false;
      }
      get ctrlKey() {
        return this.input.ctrlKey ?? false;
      }
      get altKey() {
        return this.input.altKey ?? false;
      }
      get shiftKey() {
        return this.input.shiftKey ?? false;
      }
      get repeat() {
        return this.input.repeat ?? false;
      }
      getModifierState() {
        return false;
      }
    }
    vi.stubGlobal("KeyboardEvent", InputEvent);
    vi.stubGlobal("HTMLElement", class {});
    const document = Object.assign(new EventTarget(), { activeElement: null, hidden: false });
    vi.stubGlobal("document", document);
    const target = Object.assign(new EventTarget(), {
      document,
      navigator: { platform: "MacIntel" },
    });
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+shift+]", command: "thread.next" },
      { key: "mod+w", command: "rightPanel.close" },
      { key: "mouse4", command: "thread.previous" },
    ]);
    const input = installShortcutInput(target as unknown as Window, () => ({
      keybindings,
      context: {},
    }));
    const editor = vi.fn();
    target.addEventListener(
      "keydown",
      (event) => {
        if ((event as InputEvent).key === "]") {
          editor();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    const actions: KeybindingCommand[] = [];
    target.addEventListener("keydown", (event) => {
      const command = resolveShortcutCommand(event as unknown as KeyboardEvent, keybindings, {
        platform: "MacIntel",
      });
      if (command === "thread.next" || command === "thread.previous") {
        event.preventDefault();
        actions.push(command);
      }
    });
    const next = new InputEvent("keydown", {
      key: "]",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    target.dispatchEvent(next);
    expect(actions).toEqual(["thread.next"]);
    expect(editor).not.toHaveBeenCalled();
    expect(next.defaultPrevented).toBe(true);
    const close = new InputEvent("keydown", { key: "w", metaKey: true, cancelable: true });
    target.dispatchEvent(close);
    expect(close.defaultPrevented).toBe(false);
    class MouseInput extends Event {
      button = 3;
      pointerType = "mouse";
      metaKey = false;
      ctrlKey = false;
      altKey = false;
      shiftKey = false;
    }
    const pointer = new MouseInput("pointerdown", { cancelable: true });
    target.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(false);
    expect(actions).toEqual(["thread.next"]);
    const down = new MouseInput("mousedown", { cancelable: true });
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(actions).toEqual(["thread.next", "thread.previous"]);
    input.clear();
    for (const type of ["mouseup", "auxclick"]) {
      const end = new MouseInput(type, { cancelable: true });
      target.dispatchEvent(end);
      expect(end.defaultPrevented).toBe(true);
    }
    input.dispose();
  });
});
