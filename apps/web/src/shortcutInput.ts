import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  resolveShortcutCommand,
  shortcutCommandEvent,
  shortcutKeyFromEvent,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "./keybindings";

export const SHORTCUT_PRESS_WINDOW_MS = 300;

export function createShortcutPressTracker() {
  let pending:
    | {
        key: string;
        count: number;
        commands: ReadonlyMap<number, KeybindingCommand>;
        run: (command: KeybindingCommand) => void;
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const finish = () => {
    const current = pending;
    clear();
    const command = current?.commands.get(current.count);
    if (command) current?.run(command);
  };
  return {
    clear,
    press(
      key: string,
      commands: ReadonlyMap<number, KeybindingCommand>,
      run: (command: KeybindingCommand) => void,
    ) {
      if (pending && pending.key !== key) finish();
      clearTimeout(timer);
      pending = { key, count: (pending?.count ?? 0) + 1, commands, run };
      if (pending.count >= Math.max(...commands.keys())) {
        finish();
      } else {
        timer = setTimeout(finish, SHORTCUT_PRESS_WINDOW_MS);
      }
    },
  };
}

export function mouseShortcutEvent(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): ShortcutEventLike {
  return {
    key: `mouse${event.button + 1}`,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

export function installShortcutInput(
  target: Window,
  read: () => { keybindings: ResolvedKeybindingsConfig; context: Partial<ShortcutMatchContext> },
) {
  const tracker = createShortcutPressTracker();
  const claimedButtons = new Set<number>();
  const claimedPointerButtons = new Set<number>();
  let nonMousePointer = false;
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onInput = (event: KeyboardEvent | MouseEvent) => {
    const keyboard = event instanceof KeyboardEvent;
    if (event.type === "pointerdown") {
      nonMousePointer = (event as PointerEvent).pointerType !== "mouse";
      if (nonMousePointer || (event as MouseEvent).button >= 3) return;
    }
    if (event.type === "mousedown" && nonMousePointer) return;
    if (event.type === "mousedown" && claimedPointerButtons.has((event as MouseEvent).button)) {
      stop(event);
      return;
    }
    if (!keyboard) claimedButtons.delete(event.button);
    if (keyboard && (event.key === "Unidentified" || event.isComposing)) return;
    const active = target.document.activeElement;
    if (active?.closest("[data-keybinding-capture]")) {
      tracker.clear();
      return;
    }
    const input = keyboard ? event : mouseShortcutEvent(event);
    const editable =
      active instanceof HTMLElement &&
      (active.isContentEditable ||
        active.closest("input, textarea, select, [data-terminal-owner]"));
    if (
      editable &&
      !input.metaKey &&
      !input.ctrlKey &&
      !input.altKey &&
      (keyboard || event.button < 3)
    )
      return;
    const { keybindings, context } = read();
    const commands = new Map<number, KeybindingCommand>();
    for (const presses of [1, 2, 3]) {
      const command = resolveShortcutCommand(
        {
          key: input.key,
          ...(input.code ? { code: input.code } : {}),
          metaKey: input.metaKey,
          ctrlKey: input.ctrlKey,
          altKey: input.altKey,
          shiftKey: input.shiftKey,
          ...(keyboard ? { getModifierState: event.getModifierState.bind(event) } : {}),
          presses,
        },
        keybindings,
        { context, platform: target.navigator.platform },
      );
      if (command) commands.set(presses, command);
    }
    if (commands.size === 0) return;
    if (keyboard && event.repeat) {
      stop(event);
      return;
    }
    const singleCommand = commands.get(1);
    if (keyboard && commands.size === 1 && singleCommand) {
      const commandEvent = shortcutCommandEvent(singleCommand);
      target.dispatchEvent(commandEvent);
      if (commandEvent.defaultPrevented) stop(event);
      return;
    }
    stop(event);
    if (!keyboard) {
      claimedButtons.add(event.button);
      if (event.type === "pointerdown") claimedPointerButtons.add(event.button);
    }
    const key = [
      shortcutKeyFromEvent(input),
      input.metaKey,
      input.ctrlKey,
      input.altKey,
      input.shiftKey,
    ].join("|");
    tracker.press(key, commands, (command) => target.dispatchEvent(shortcutCommandEvent(command)));
  };
  const onMouseEnd = (event: MouseEvent) => {
    if (event.type === "click" || event.type === "auxclick") nonMousePointer = false;
    if (event.type === "mouseup") claimedPointerButtons.delete(event.button);
    if (!claimedButtons.has(event.button)) return;
    stop(event);
    if (event.type === "click" || event.type === "auxclick") claimedButtons.delete(event.button);
  };
  const clear = () => {
    tracker.clear();
    claimedButtons.clear();
    claimedPointerButtons.clear();
    nonMousePointer = false;
  };
  const onVisibility = () => {
    if (target.document.hidden) clear();
  };
  target.addEventListener("keydown", onInput, true);
  target.addEventListener("pointerdown", onInput, true);
  target.addEventListener("mousedown", onInput, true);
  for (const type of ["mouseup", "click", "auxclick", "contextmenu"] as const) {
    target.addEventListener(type, onMouseEnd, true);
  }
  target.addEventListener("blur", clear);
  target.addEventListener("pointercancel", clear);
  target.document.addEventListener("visibilitychange", onVisibility);
  return {
    clear: tracker.clear,
    dispose() {
      clear();
      target.removeEventListener("keydown", onInput, true);
      target.removeEventListener("pointerdown", onInput, true);
      target.removeEventListener("mousedown", onInput, true);
      for (const type of ["mouseup", "click", "auxclick", "contextmenu"] as const) {
        target.removeEventListener(type, onMouseEnd, true);
      }
      target.removeEventListener("blur", clear);
      target.removeEventListener("pointercancel", clear);
      target.document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
