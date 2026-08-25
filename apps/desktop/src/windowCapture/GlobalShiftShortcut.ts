import { BOTH_SHIFT_KEYS_IDLE, updateBothShiftKeys } from "./windowCapture.ts";

interface GlobalKeyHook {
  on(event: "keydown", listener: (event: { keycode: number }) => void): unknown;
  on(event: "keyup", listener: (event: { keycode: number }) => void): unknown;
  off(event: "keydown", listener: (event: { keycode: number }) => void): unknown;
  off(event: "keyup", listener: (event: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

export function startGlobalShiftShortcut(hook: GlobalKeyHook, onTrigger: () => void): () => void {
  let state = BOTH_SHIFT_KEYS_IDLE;
  let stopped = false;
  const update = (pressed: boolean) => (event: { keycode: number }) => {
    const next = updateBothShiftKeys(state, event.keycode, pressed);
    state = next.state;
    if (next.triggered) {
      try {
        onTrigger();
      } catch {}
    }
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
