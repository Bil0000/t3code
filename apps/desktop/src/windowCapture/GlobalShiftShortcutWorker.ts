import { parentPort } from "electron";
import { uIOhook } from "uiohook-napi";

import { startGlobalShiftShortcut } from "./GlobalShiftShortcut.ts";

const stop = startGlobalShiftShortcut(uIOhook, () => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron parentPort is not Window.postMessage.
  parentPort.postMessage("trigger");
});

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron parentPort is not Window.postMessage.
parentPort.postMessage("ready");
process.once("SIGTERM", () => {
  stop();
  process.exit(0);
});
