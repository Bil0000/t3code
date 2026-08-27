import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

export function ComposerGlassHost({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("chat-composer-glass-host relative z-10 w-full rounded-[22px]", className)}
    />
  );
}

export function ComposerGlassMainSurface({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-chat-composer-main-surface="true"
      className={cn("group relative z-10 rounded-[22px] p-px", className)}
    />
  );
}

export function ComposerGlassSurface({ className, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} data-chat-composer-surface="true" className={cn("rounded-[20px]", className)} />
  );
}
