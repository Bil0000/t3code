import type { WindowCaptureSource } from "@t3tools/contracts";
import { ImageIcon, TextIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const WINDOW_CAPTURE_ATTACHMENT_FRAME_CLASS =
  "relative h-28 w-52 max-w-full overflow-hidden rounded-lg border border-border/80";

export function WindowCaptureAttachmentDetails({
  source,
  className,
}: {
  source: WindowCaptureSource;
  className?: string;
}) {
  const includesAccessibility = Boolean(source.accessibility || source.accessibleText?.trim());
  const captureContents = includesAccessibility
    ? "Screenshot and accessibility data included"
    : "Screenshot only — no accessibility data included";

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-linear-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-2 pt-6",
        className,
      )}
    >
      {source.appIconDataUrl ? (
        <img src={source.appIconDataUrl} alt="" className="size-7 shrink-0 rounded-md" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/20 text-[10px] font-medium text-white uppercase">
          {source.appName.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-3.5 text-white">
          <span className="truncate">{source.appName}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={captureContents}
                  tabIndex={0}
                  className="pointer-events-auto inline-flex shrink-0 cursor-default rounded-sm text-white/60 outline-none focus-visible:ring-1 focus-visible:ring-white/70"
                />
              }
            >
              {includesAccessibility ? (
                <TextIcon className="size-3" aria-hidden="true" />
              ) : (
                <ImageIcon className="size-3" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup>{captureContents}</TooltipPopup>
          </Tooltip>
        </div>
        <div className="truncate text-[9px] leading-3.5 text-white/70">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
