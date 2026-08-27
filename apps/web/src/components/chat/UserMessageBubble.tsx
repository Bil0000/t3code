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
