import { Fragment, type ReactNode } from "react";
import { BotIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import type { ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly showDetailSeparator?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const content = (
    <>
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      <span className="font-medium">{props.label}</span>
      {props.detail ? (
        <span
          className={cn(
            "inline-flex min-w-0 max-w-80 items-center opacity-70",
            typeof props.detail === "string" && "truncate",
          )}
        >
          {props.showDetailSeparator === false ? null : "·\u00a0"}
          {props.detail}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-[11px] text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.actionLabel}
                onClick={props.onAction}
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-muted"
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1">
          {content}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/** Where a subagent thread sits: every agent above it, root first, each one clickable. */
export function SubagentAncestryDivider(props: {
  readonly links: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-2 text-[11px] text-muted-foreground">
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border/70" />
      <nav
        aria-label="Parent agents"
        className="flex min-w-0 max-w-[85%] items-center gap-0.5 rounded-full border border-border/70 bg-background py-0.5 ps-2.5 pe-0.5"
      >
        <BotIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0 ps-1 pe-0.5 font-medium">Subagent of</span>
        {props.links.map((link, index) => {
          const isParent = index === props.links.length - 1;
          return (
            <Fragment key={link.threadId}>
              {index > 0 ? (
                <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-50" />
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={isParent ? "Open parent thread" : `Open ${link.title}`}
                      onClick={() => props.onOpenThread(link.threadId)}
                      className={cn(
                        "min-w-0 cursor-pointer truncate rounded-full px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isParent ? "shrink-0 max-w-60 text-foreground/80" : "max-w-40 opacity-70",
                      )}
                    />
                  }
                >
                  {link.title}
                </TooltipTrigger>
                <TooltipPopup side="top">{link.title}</TooltipPopup>
              </Tooltip>
            </Fragment>
          );
        })}
      </nav>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border/70" />
    </div>
  );
}
