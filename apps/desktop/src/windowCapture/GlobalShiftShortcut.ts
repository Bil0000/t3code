import { BOTH_SHIFT_KEYS_IDLE, updateBothShiftKeys } from "./windowCapture.ts";

interface GlobalKeyHook {
  on(event: "keydown", listener: (event: { keycode: number; time: number }) => void): unknown;
  on(event: "keyup", listener: (event: { keycode: number; time: number }) => void): unknown;
  off(event: "keydown", listener: (event: { keycode: number; time: number }) => void): unknown;
  off(event: "keyup", listener: (event: { keycode: number; time: number }) => void): unknown;
  start(): void;
  stop(): void;
}

const SHIFT_DOUBLE_TAP_MS = 400;

export function startGlobalShiftShortcut(hook: GlobalKeyHook, onTrigger: () => void): () => void {
  let state = BOTH_SHIFT_KEYS_IDLE;
  let lastShiftPressAt: number | undefined;
  let stopped = false;
  const trigger = () => {
    try {
      onTrigger();
    } catch {}
  };
  const update = (pressed: boolean) => (event: { keycode: number; time: number }) => {
    const wasPressed =
      event.keycode === 42 ? state.leftPressed : event.keycode === 54 ? state.rightPressed : false;
    const next = updateBothShiftKeys(state, event.keycode, pressed);
    state = next.state;
    const isShift = event.keycode === 42 || event.keycode === 54;
    if (pressed && !isShift) lastShiftPressAt = undefined;
    if (!pressed || !isShift || wasPressed) return;
    if (next.triggered) {
      lastShiftPressAt = undefined;
      trigger();
      return;
    }
    if (lastShiftPressAt !== undefined && event.time - lastShiftPressAt <= SHIFT_DOUBLE_TAP_MS) {
      lastShiftPressAt = undefined;
      trigger();
      return;
    }
    lastShiftPressAt = event.time;
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
