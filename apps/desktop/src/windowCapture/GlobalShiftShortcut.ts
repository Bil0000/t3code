import type { WindowCaptureModifier } from "@t3tools/contracts";

import {
  MODIFIER_PAIR_IDLE,
  UIOHOOK_MODIFIER_KEYCODES,
  updateModifierPair,
} from "./windowCapture.ts";

interface GlobalKeyHook {
  on(event: "keydown", listener: (event: { keycode: number; time: number }) => void): unknown;
  on(event: "keyup", listener: (event: { keycode: number; time: number }) => void): unknown;
  off(event: "keydown", listener: (event: { keycode: number; time: number }) => void): unknown;
  off(event: "keyup", listener: (event: { keycode: number; time: number }) => void): unknown;
  start(): void;
  stop(): void;
}

const MODIFIER_DOUBLE_TAP_MS = 400;

export function startGlobalShiftShortcut(
  hook: GlobalKeyHook,
  onTrigger: () => void,
  modifier: WindowCaptureModifier = "shift",
): () => void {
  const pair = UIOHOOK_MODIFIER_KEYCODES[modifier];
  const [leftKeycode, rightKeycode] = pair;
  let state = MODIFIER_PAIR_IDLE;
  let lastModifierPress: { readonly keycode: number; readonly time: number } | undefined;
  let stopped = false;
  const trigger = () => {
    try {
      onTrigger();
    } catch {}
  };
  const update = (pressed: boolean) => (event: { keycode: number; time: number }) => {
    const wasPressed =
      event.keycode === leftKeycode
        ? state.leftPressed
        : event.keycode === rightKeycode
          ? state.rightPressed
          : false;
    const next = updateModifierPair(state, pair, event.keycode, pressed);
    state = next.state;
    const isPairKey = event.keycode === leftKeycode || event.keycode === rightKeycode;
    if (pressed && !isPairKey) lastModifierPress = undefined;
    if (!pressed || !isPairKey || wasPressed) return;
    if (next.triggered) {
      lastModifierPress = undefined;
      trigger();
      return;
    }
    if (
      lastModifierPress?.keycode === event.keycode &&
      event.time - lastModifierPress.time <= MODIFIER_DOUBLE_TAP_MS
    ) {
      lastModifierPress = undefined;
      trigger();
      return;
    }
    lastModifierPress = { keycode: event.keycode, time: event.time };
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
