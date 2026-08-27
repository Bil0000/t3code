import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function UserMessageBubble({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-user-message-bubble="true"
      className={cn(
        "relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground",
        className,
      )}
    />
  );
}

export function UserMessageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-user-message-actions="true"
      className={cn(
        "flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100",
        className,
      )}
    />
  );
}
