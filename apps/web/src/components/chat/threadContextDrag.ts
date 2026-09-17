import type { ScopedThreadRef } from "@t3tools/contracts";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function threadContextDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>("[data-thread-context-drop]") ?? null
  );
}

export function clearThreadContextDropTarget() {
  document.querySelectorAll("[data-thread-context-over]").forEach((element) => {
    element.removeAttribute("data-thread-context-over");
  });
}

export function dropThreadContext(target: HTMLElement, threads: ReadonlyArray<ScopedThreadRef>) {
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
}
