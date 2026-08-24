import type { WindowCaptureSource } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

export function WindowCaptureAttachmentDetails({
  source,
  className,
}: {
  source: WindowCaptureSource;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-2 pt-6",
        className,
      )}
    >
      {source.appIconDataUrl ? (
        <img
          src={source.appIconDataUrl}
          alt=""
          className="size-6 shrink-0 rounded-md ring-1 ring-white/20"
        />
      ) : (
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white/20 text-xs font-medium text-white ring-1 ring-white/20">
          {source.appName.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-white">{source.appName}</div>
        <div className="truncate text-[11px] text-white/70">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
