import * as Electron from "electron";

export function startGlobalShiftShortcutProcess(
  workerPath: string,
  onTrigger: () => void,
): Promise<() => void> {
  const worker = Electron.utilityProcess.fork(workerPath, [], {
    serviceName: "Window Capture Shortcut",
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
      if (settled) return;
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
    worker.once("error", (type, location) => {
      fail(new Error(`Window capture shortcut helper failed: ${type} at ${location}`));
    });
    worker.once("exit", (code) => {
      fail(new Error(`Window capture shortcut helper exited with code ${code}`));
    });
  });
}
