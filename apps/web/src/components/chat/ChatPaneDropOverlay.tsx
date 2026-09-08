import { useEffect, useRef, type ReactNode } from "react";

import { type ChatPaneId, type DropZone } from "~/chatPanes.logic";
import { chatPaneDragPointer, useChatPaneDragStore } from "~/chatPaneDragStore";
import { cn } from "~/lib/utils";

const ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
};

interface ChatPaneDropOverlayProps {
  paneId: ChatPaneId;
  /** Which edge the pointer would split, or null when the tree refuses every zone. */
  resolveZone: (rect: DOMRect, clientX: number, clientY: number) => DropZone | null;
  children: ReactNode;
}

/**
 * Wraps one pane and paints the half it would give to the carried thread.
 * Pointer moves are read at the document so the gesture works no matter
 * which sensor owns it, and the resolved zone is published to the drag store
 * for the owner to apply on release. Nothing here is hit-testable, so a
 * resting pane never intercepts clicks or wheel events.
 */
export function ChatPaneDropOverlay({ paneId, resolveZone, children }: ChatPaneDropOverlayProps) {
  const dragging = useChatPaneDragStore(
    (state) => state.threadRef !== null && state.sourcePaneId !== paneId,
  );
  const zone = useChatPaneDragStore((state) =>
    state.target?.paneId === paneId ? state.target.zone : null,
  );
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let rect = wrapper.getBoundingClientRect();
    let measuredAt = performance.now();
    const setTarget = useChatPaneDragStore.getState().setTarget;
    const track = (x: number, y: number) => {
      const now = performance.now();
      if (now - measuredAt > 100) {
        rect = wrapper.getBoundingClientRect();
        measuredAt = now;
      }
      chatPaneDragPointer.current = { x, y };
      setTarget(paneId, resolveZone(rect, x, y));
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.isPrimary) track(event.clientX, event.clientY);
    };
    const last = chatPaneDragPointer.current;
    if (last) track(last.x, last.y);
    document.addEventListener("pointermove", onPointerMove, { capture: true });
    return () => {
      document.removeEventListener("pointermove", onPointerMove, { capture: true });
      setTarget(paneId, null);
    };
  }, [dragging, paneId, resolveZone]);

  return (
    <div ref={wrapperRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-40" data-chat-pane-drop-zones>
          <div
            data-chat-pane-drop-zone={zone ?? undefined}
            className={cn(
              "absolute m-1.5 rounded-xl border border-primary/50 bg-primary/12 opacity-0 transition-[opacity,inset,width,height] duration-150 ease-out motion-reduce:transition-none",
              zone && ZONE_CLASS[zone],
              zone && "opacity-100",
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
