import type { SourceControlActor } from "@t3tools/contracts";
import { Children, isValidElement, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SourceControlActorAvatar({
  actor,
  className,
}: {
  actor: SourceControlActor | null;
  className?: string;
}) {
  const login = actor?.login ?? "ghost";
  const avatarUrl = actor?.avatarUrl ?? null;
  return avatarUrl === null ? (
    // Not every host reports an avatar, so the initial stands in where none arrives.
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground",
        className,
      )}
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      aria-hidden
      alt=""
      src={avatarUrl}
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
    />
  );
}

/** GitHub attributes work from a deleted account to "ghost"; say the same word everywhere. */
export function SourceControlActorLabel({
  actor,
  className,
  labelClassName,
  tooltip = true,
  profileUrl,
}: {
  actor: SourceControlActor | null;
  className?: string;
  labelClassName?: string;
  tooltip?: boolean;
  profileUrl?: string | null;
}) {
  const login = actor?.login ?? "ghost";
  const label = (
    <>
      <SourceControlActorAvatar actor={actor} />
      <span className={cn("truncate", labelClassName)}>{login}</span>
    </>
  );
  if (!tooltip) {
    return <span className={cn("flex min-w-0 items-center gap-1.5", className)}>{label}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${login}'s profile`}
            />
          ) : (
            <span />
          )
        }
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          profileUrl &&
            "cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          className,
        )}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{profileUrl ? `Open ${login}'s profile` : login}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Dot-separated metadata. It owns the separator, and draws one only between the segments that
 * survive, so a caller can render `{condition ? <span/> : null}` without leaving a stray dot.
 * `Children.toArray` drops the nullish entries and keys what remains, which a plain array
 * check would not do for a single child or a fragment. A separator borrows the key of the
 * segment it precedes, so it stays stable without counting positions.
 */
function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

export function SourceControlMetaLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                key={separatorKey(segment)}
              >
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}
