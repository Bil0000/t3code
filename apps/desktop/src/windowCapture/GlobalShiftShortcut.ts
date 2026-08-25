import type { WindowCaptureModifier } from "@t3tools/contracts";

import {
  MODIFIER_PAIR_IDLE,
  UIOHOOK_MODIFIER_KEYCODES,
  updateModifierPair,
} from "./windowCapture.ts";

interface GlobalKeyHook {
  on(event: "keydown", listener: (event: { keycode: number }) => void): unknown;
  on(event: "keyup", listener: (event: { keycode: number }) => void): unknown;
  off(event: "keydown", listener: (event: { keycode: number }) => void): unknown;
  off(event: "keyup", listener: (event: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

export function startGlobalShiftShortcut(
  hook: GlobalKeyHook,
  onTrigger: () => void,
  modifier: WindowCaptureModifier,
): () => void {
  const pair = UIOHOOK_MODIFIER_KEYCODES[modifier];
  let state = MODIFIER_PAIR_IDLE;
  let stopped = false;
  const trigger = () => {
    try {
      onTrigger();
    } catch {}
  };
  const update = (pressed: boolean) => (event: { keycode: number }) => {
    const next = updateModifierPair(state, pair, event.keycode, pressed);
    state = next.state;
    if (next.triggered) trigger();
  };
  const keyDown = update(true);
  const keyUp = update(false);
  hook.on("keydown", keyDown);
  hook.on("keyup", keyUp);
  try {
    hook.start();
  } catch (error) {
    hook.off("keydown", keyDown);
    hook.off("keyup", keyUp);
    throw error;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    hook.off("keydown", keyDown);
    hook.off("keyup", keyUp);
    hook.stop();
  };
}
