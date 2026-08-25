import { WINDOW_CAPTURE_MODIFIERS, type WindowCaptureModifier } from "@t3tools/contracts";
import { uIOhook } from "uiohook-napi";

import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";

const requested = process.argv[2];
if (!(WINDOW_CAPTURE_MODIFIERS as readonly string[]).includes(requested ?? "")) {
  process.exit(1);
}
const modifier = requested as WindowCaptureModifier;

const stop = startGlobalShiftShortcut(
  uIOhook,
  () => {
    process.send?.("trigger");
  },
  modifier,
);

process.send?.("ready");
const shutdown = () => {
  try {
    stop();
  } finally {
    process.exit(0);
  }
};
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
