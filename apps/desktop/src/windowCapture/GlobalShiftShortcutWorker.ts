import { uIOhook } from "uiohook-napi";

import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";

const stop = startGlobalShiftShortcut(uIOhook, () => {
  process.send?.("trigger");
});

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
