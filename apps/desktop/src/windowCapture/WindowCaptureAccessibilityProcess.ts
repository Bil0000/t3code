// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.

import * as NodeChildProcess from "node:child_process";

import type {
  CapturedWindowAccessibilityContext,
  WindowCaptureAccessibilityRequest,
} from "./WindowCaptureAccessibility.ts";

const START_TIMEOUT_MS = 1_000;
const RESULT_TIMEOUT_MS = 4_000;

type AccessibilityRead = {
  readonly started: Promise<void>;
  readonly result: Promise<CapturedWindowAccessibilityContext | undefined>;
};

type AccessibilityProcess = {
  readonly read: (request: WindowCaptureAccessibilityRequest) => AccessibilityRead;
  readonly close: () => void;
};

type AccessibilityMessage =
  | "ready"
  | "started"
  | { readonly type: "result"; readonly context?: CapturedWindowAccessibilityContext };

const completedRead = (context?: CapturedWindowAccessibilityContext): AccessibilityRead => ({
  started: Promise.resolve(),
  result: Promise.resolve(context),
});

const unavailableProcess = (): AccessibilityProcess => ({
  read: () => completedRead(),
  close: () => undefined,
});

export function startWindowCaptureAccessibilityProcess(workerPath: string): AccessibilityProcess {
  let worker: NodeChildProcess.ChildProcess;
  try {
    worker = NodeChildProcess.fork(workerPath, ["read"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
  } catch {
    return unavailableProcess();
  }

  let ready = false;
  let request: WindowCaptureAccessibilityRequest | undefined;
  let startedResolve: (() => void) | undefined;
  let resultResolve: ((value: CapturedWindowAccessibilityContext | undefined) => void) | undefined;
  let startTimeout: ReturnType<typeof setTimeout> | undefined;
  let resultTimeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let settledContext: CapturedWindowAccessibilityContext | undefined;

  const clearTimers = () => {
    if (startTimeout) clearTimeout(startTimeout);
    if (resultTimeout) clearTimeout(resultTimeout);
  };
  const finish = (context?: CapturedWindowAccessibilityContext) => {
    if (settled) return;
    settled = true;
    settledContext = context;
    clearTimers();
    startedResolve?.();
    resultResolve?.(context);
    worker.kill();
  };
  const sendRequest = () => {
    if (!ready || !request || settled) return;
    try {
      worker.send(request, (error) => {
        if (error) finish();
      });
    } catch {
      finish();
    }
  };

  worker.on("message", (rawMessage) => {
    const message = rawMessage as AccessibilityMessage;
    if (message === "ready") {
      ready = true;
      sendRequest();
    } else if (message === "started") {
      if (startTimeout) clearTimeout(startTimeout);
      startedResolve?.();
    } else {
      finish(message.context);
    }
  });
  worker.once("error", () => finish());
  worker.once("exit", () => finish());

  return {
    read: (nextRequest) => {
      if (settled) return completedRead(settledContext);
      request = nextRequest;
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<CapturedWindowAccessibilityContext | undefined>();
      startedResolve = started.resolve;
      resultResolve = result.resolve;
      startTimeout = setTimeout(() => finish(), START_TIMEOUT_MS);
      resultTimeout = setTimeout(() => finish(), RESULT_TIMEOUT_MS);
      startTimeout.unref();
      resultTimeout.unref();
      sendRequest();
      return { started: started.promise, result: result.promise };
    },
    close: () => finish(),
  };
}
