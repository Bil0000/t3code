import type { WindowCaptureAccessibilityNode, WindowCaptureSource } from "@t3tools/contracts";
import { ImageIcon, TextIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

export const WINDOW_CAPTURE_ATTACHMENT_FRAME_CLASS =
  "relative h-28 w-52 max-w-full overflow-hidden rounded-lg border border-border/80";

export function windowCaptureAccessibilityText(source: WindowCaptureSource): string | undefined {
  const legacyText = source.accessibleText?.trim();
  if (legacyText) return legacyText;
  if (!source.accessibility) return undefined;
  if (source.accessibility.format === "flat-text") return source.accessibility.text;

  const lines: string[] = [];
  const seen = new Set<string>();
  const stack: WindowCaptureAccessibilityNode[] = [source.accessibility.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const value of [node.name, node.value, node.description]) {
      const text = value?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lines.push(text);
    }
    stack.push(...node.children.toReversed());
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function windowCaptureIncludesAccessibility(source: WindowCaptureSource): boolean {
  return Boolean(source.accessibility || source.accessibleText?.trim());
}

export function WindowCaptureContentsButton({
  source,
  className,
  side = "top",
}: {
  source: WindowCaptureSource;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const includesAccessibility = windowCaptureIncludesAccessibility(source);
  const ContentsIcon = includesAccessibility ? TextIcon : ImageIcon;
  const accessibilityText = windowCaptureAccessibilityText(source);
  const title = includesAccessibility ? "Screenshot + accessibility" : "Screenshot only";
  const description = includesAccessibility
    ? "Accessibility data was included with this screenshot."
    : "The app or capture backend did not provide verified accessibility data.";

  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          includesAccessibility ? "View accessibility details" : "View screenshot details"
        }
        title={title}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <ContentsIcon className="size-3" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup
        side={side}
        align="center"
        className="w-[min(24rem,calc(100vw-2rem))]"
        viewportClassName="max-h-[min(28rem,70vh)]"
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <ContentsIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <PopoverTitle className="text-sm leading-5">{title}</PopoverTitle>
              <PopoverDescription className="mt-0.5 text-xs leading-4">
                {description}
              </PopoverDescription>
            </div>
          </div>
          {accessibilityText ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Extracted accessibility data</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/45 p-2.5 font-mono text-[11px] leading-4">
                {accessibilityText}
              </pre>
            </div>
          ) : includesAccessibility ? (
            <div className="rounded-md border border-border/70 bg-muted/45 p-2.5 text-muted-foreground text-xs leading-4">
              Structured accessibility elements were included, but they have no readable names or
              values.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

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
          <WindowCaptureContentsButton
            source={source}
            className="pointer-events-auto text-white/60 hover:text-white focus-visible:ring-white/70"
          />
        </div>
        <div className="truncate text-[9px] leading-3.5 text-white/70">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
