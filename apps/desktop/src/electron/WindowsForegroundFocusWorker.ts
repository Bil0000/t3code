import * as NodeWorkerThreads from "node:worker_threads";

import type { WindowsForegroundFocusTarget } from "./WindowsForegroundFocusThread.ts";
import type { Element } from "@crowecawcaw/xa11y";

type FocusRequest = {
  readonly type: "focus";
  readonly requestId: number;
  readonly target: WindowsForegroundFocusTarget;
};

function matchesTarget(
  element: {
    readonly name?: string | null;
    readonly bounds: WindowsForegroundFocusTarget["bounds"] | null;
  },
  target: WindowsForegroundFocusTarget,
): boolean {
  if ((element.name ?? "").trim() !== target.title.trim()) return false;
  if (!element.bounds) return false;
  return [target.bounds, target.contentBounds].some((bounds) =>
    (["x", "y", "width", "height"] as const).every(
      (key) => Math.abs(element.bounds![key] - bounds[key]) <= 2,
    ),
  );
}

async function focusTarget(
  App: (typeof import("@crowecawcaw/xa11y"))["App"],
  target: WindowsForegroundFocusTarget,
): Promise<boolean> {
  const key = JSON.stringify(target);
  if (cachedElement?.key === key) {
    try {
      await cachedElement.element.focus();
      return true;
    } catch {
      cachedElement = undefined;
    }
  }
  const app = await App.byPid(target.processId, { timeout: 0 });
  const children = await app.children();
  const element =
    children.find((candidate) => matchesTarget(candidate, target)) ??
    (await App.list())
      .filter((candidate) => candidate.pid === target.processId)
      .map((candidate) => candidate.asElement())
      .find((candidate) => matchesTarget(candidate, target));
  if (!element) return false;
  cachedElement = { key, element };
  await element.focus();
  return true;
}

let cachedElement: { readonly key: string; readonly element: Element } | undefined;

async function start() {
  const { App } = await import("@crowecawcaw/xa11y");
  const parentPort = NodeWorkerThreads.parentPort;
  if (!parentPort) return;
  let work = Promise.resolve();
  parentPort.on("message", (message: FocusRequest) => {
    if (message.type !== "focus") return;
    work = work.then(async () => {
      const focused = await focusTarget(App, message.target).catch(() => false);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      parentPort.postMessage({ type: "result", requestId: message.requestId, focused });
    });
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
  parentPort.postMessage("ready");
}

void start();
