import { GripVerticalIcon } from "lucide-react";
import { useRef } from "react";

export function PaneResizeHandle(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onMove: (delta: number) => void;
  onReset: () => void;
}) {
  const lastClientX = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      tabIndex={0}
      className="group relative z-10 hidden w-2 shrink-0 cursor-col-resize touch-none bg-background/70 outline-none @min-[1380px]/history-list:block"
      onPointerDown={(event) => {
        lastClientX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (lastClientX.current === null) return;
        const delta = event.clientX - lastClientX.current;
        lastClientX.current = event.clientX;
        props.onMove(delta);
      }}
      onPointerUp={(event) => {
        lastClientX.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        lastClientX.current = null;
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
