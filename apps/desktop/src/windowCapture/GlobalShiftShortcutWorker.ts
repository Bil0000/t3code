import { WINDOW_CAPTURE_MODIFIERS, type WindowCaptureModifier } from "@t3tools/contracts";
import { uIOhook } from "uiohook-napi";

import {
  MODIFIER_PAIR_IDLE,
  UIOHOOK_MODIFIER_KEYCODES,
  updateModifierPair,
} from "./windowCapture.ts";

const requested = process.argv[2];
if (!(WINDOW_CAPTURE_MODIFIERS as readonly string[]).includes(requested ?? "")) {
  process.exit(1);
}
const modifier = requested as WindowCaptureModifier;

const pair = UIOHOOK_MODIFIER_KEYCODES[modifier];
let state = MODIFIER_PAIR_IDLE;
const update = (pressed: boolean) => (event: { keycode: number }) => {
  const next = updateModifierPair(state, pair, event.keycode, pressed);
  state = next.state;
  if (next.triggered) {
    try {
      process.send?.("trigger");
    } catch {}
  }
};

uIOhook.on("keydown", update(true));
uIOhook.on("keyup", update(false));
uIOhook.start();

process.send?.("ready");
const shutdown = () => {
  process.exit(0);
};
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
