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
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      {source.appIconDataUrl ? (
        <img src={source.appIconDataUrl} alt="" className="size-7 shrink-0 rounded-md" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-medium text-secondary-foreground">
          {source.appName.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{source.appName}</div>
        <div className="truncate text-[11px] text-secondary-label">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
