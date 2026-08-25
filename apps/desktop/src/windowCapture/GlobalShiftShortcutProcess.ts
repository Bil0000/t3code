// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";

import type { WindowCaptureModifier } from "@t3tools/contracts";

export function startGlobalShiftShortcutProcess(
  workerPath: string,
  modifier: WindowCaptureModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const worker = NodeChildProcess.fork(workerPath, [modifier], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      worker.kill();
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

    worker.on("message", (message) => {
      if (message === "ready" && !settled) {
        settled = true;
        resolve(stop);
        return;
      }
      if (message !== "trigger" || !settled || stopped) return;
      try {
        onTrigger();
      } catch {}
    });
    worker.once("error", (error) => {
      fail(error);
    });
    worker.once("exit", (code) => {
      fail(new Error(`Window capture shortcut helper exited with code ${code}`));
    });
  });
}
