// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native modifier-key poller with Node.

import * as NodeChildProcess from "node:child_process";

import type { SnapShotModifierKey } from "@t3tools/contracts";

const MAC_MODIFIER_DEVICE_MASKS: Record<SnapShotModifierKey, number> = {
  ShiftLeft: 0x2,
  ShiftRight: 0x4,
  ControlLeft: 0x1,
  ControlRight: 0x2000,
  AltLeft: 0x20,
  AltRight: 0x40,
  MetaLeft: 0x8,
  MetaRight: 0x10,
};

const POLLER_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const masks = JSON.parse(argv[0]);
  let active = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const flags = $.CGEventSourceFlagsState(0);
    const pressed = masks.some(function(mask) { return (flags & mask) === mask; });
    if (pressed && !active) console.log("trigger");
    active = pressed;
    delay(0.05);
  }
  return "orphaned";
}`;

export function startMacModifierPairShortcutProcess(
  shortcuts: readonly (readonly [SnapShotModifierKey, SnapShotModifierKey])[],
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const masks = shortcuts.map(
    ([first, second]) => MAC_MODIFIER_DEVICE_MASKS[first] | MAC_MODIFIER_DEVICE_MASKS[second],
  );
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT, JSON.stringify(masks)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      poller.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        if (message !== "trigger" || !settled || stopped) continue;
        try {
          onTrigger();
        } catch {}
      }
    });
    poller.once("error", (error) => {
      fail(error);
    });
    poller.once("exit", (code) => {
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
