// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
// Windows modifier-pair listener. Runs in a forked Node-mode child so a stuck or
// crashed FFI call cannot take the main process with it. Mirrors the macOS
// poller: sample both physical keys at 20 Hz, fire on the rising edge.
import { SnapShotModifierKey, snapShotModifierKeyParts } from "@t3tools/contracts";

import * as Schema from "effect/Schema";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

const POLL_INTERVAL_MS = 50;

const shortcuts = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Tuple([SnapShotModifierKey, SnapShotModifierKey])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
  ),
)(process.argv[2]).map((keys) =>
  keys.map((key) => {
    const { modifier, side } = snapShotModifierKeyParts(key);
    return WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[modifier][side === "Left" ? 0 : 1];
  }),
);

async function poll() {
  const api = await loadWindowsForegroundApi();
  let active = false;
  process.send?.("ready");
  const timer = setInterval(() => {
    const pressed = shortcuts.some((keys) => keys.every((key) => api.isKeyDown(key)));
    if (pressed && !active) {
      try {
        process.send?.("trigger");
      } catch {}
    }
    active = pressed;
  }, POLL_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
