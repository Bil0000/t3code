import { GripVerticalIcon } from "lucide-react";
import { useEffect, useRef } from "react";

export function PaneResizeHandle(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onMove: (delta: number) => void;
  onReset: () => void;
}) {
  const onMoveRef = useRef(props.onMove);
  const dragStateRef = useRef<{
    pointerId: number;
    lastClientX: number;
    pendingDelta: number;
    rafId: number | null;
  } | null>(null);
  onMoveRef.current = props.onMove;

  useEffect(() => {
    return () => {
      const state = dragStateRef.current;
      if (state && state.rafId !== null) cancelAnimationFrame(state.rafId);
      dragStateRef.current = null;
    };
  }, []);

  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      tabIndex={0}
      className="group relative z-10 block w-2 shrink-0 cursor-col-resize touch-none bg-background/70 outline-none"
      onPointerDown={(event) => {
        dragStateRef.current = {
          pointerId: event.pointerId,
          lastClientX: event.clientX,
          pendingDelta: 0,
          rafId: null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        state.pendingDelta += event.clientX - state.lastClientX;
        state.lastClientX = event.clientX;
        if (state.rafId !== null) return;
        state.rafId = requestAnimationFrame(() => {
          const active = dragStateRef.current;
          if (!active) return;
          active.rafId = null;
          const delta = active.pendingDelta;
          active.pendingDelta = 0;
          if (delta !== 0) onMoveRef.current(delta);
        });
      }}
      onPointerUp={(event) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        state.pendingDelta += event.clientX - state.lastClientX;
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
        const delta = state.pendingDelta;
        dragStateRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (delta !== 0) onMoveRef.current(delta);
      }}
      onLostPointerCapture={(event) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
        const delta = state.pendingDelta;
        dragStateRef.current = null;
        if (delta !== 0) onMoveRef.current(delta);
      }}
      onDoubleClick={props.onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        props.onMove(event.key === "ArrowLeft" ? -16 : 16);
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary" />
      <GripVerticalIcon className="absolute top-1/2 left-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-background text-muted-foreground/55 group-hover:text-primary group-focus-visible:text-primary" />
    </div>
  );
}
