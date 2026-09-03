// @effect-diagnostics globalTimers:off -- The helper timeout runs at a worker callback boundary outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node worker.

import * as NodeWorkerThreads from "node:worker_threads";

import type * as Electron from "electron";

const FOCUS_TIMEOUT_MS = 1_000;

export type WindowsForegroundFocusTarget = {
  readonly processId: number;
  readonly title: string;
  readonly bounds: Electron.Rectangle;
  readonly contentBounds: Electron.Rectangle;
};

export type WindowsForegroundFocusThread = {
  readonly focus: (target: WindowsForegroundFocusTarget) => Promise<boolean>;
  readonly close: () => void;
};

type FocusRequest = {
  readonly type: "focus";
  readonly requestId: number;
  readonly target: WindowsForegroundFocusTarget;
};

type FocusResult = {
  readonly type: "result";
  readonly requestId: number;
  readonly focused: boolean;
};

const unavailableThread = (): WindowsForegroundFocusThread => ({
  focus: async () => false,
  close: () => undefined,
});

export function startWindowsForegroundFocusThread(
  workerPath: string,
): WindowsForegroundFocusThread {
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(workerPath);
    worker.unref();
  } catch {
    return unavailableThread();
  }

  let ready = false;
  let closed = false;
  let nextRequestId = 1;
  const queued = new Map<number, FocusRequest>();
  const pending = new Map<
    number,
    {
      readonly resolve: (focused: boolean) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const finish = (requestId: number, focused: boolean) => {
    queued.delete(requestId);
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timeout);
    request.resolve(focused);
  };
  const send = (request: FocusRequest) => {
    if (!ready || closed) return;
    queued.delete(request.requestId);
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(request);
    } catch {
      finish(request.requestId, false);
    }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const requestId of pending.keys()) finish(requestId, false);
    void worker.terminate();
  };

  worker.on("message", (rawMessage) => {
    if (rawMessage === "ready") {
      ready = true;
      for (const request of queued.values()) send(request);
      return;
    }
    const message = rawMessage as FocusResult;
    if (message.type === "result") finish(message.requestId, message.focused);
  });
  worker.once("error", stop);
  worker.once("exit", stop);

  return {
    focus: (target) =>
      new Promise<boolean>((resolve) => {
        if (closed) {
          resolve(false);
          return;
        }
        const requestId = nextRequestId++;
        const request = { type: "focus", requestId, target } satisfies FocusRequest;
        const timeout = setTimeout(() => finish(requestId, false), FOCUS_TIMEOUT_MS);
        timeout.unref();
        queued.set(requestId, request);
        pending.set(requestId, { resolve, timeout });
        send(request);
      }),
    close: stop,
  };
}
