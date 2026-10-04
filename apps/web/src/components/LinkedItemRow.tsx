import { MoreHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "./ui/button";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The row shape of the Linked tab, for pull requests and issues alike. The tab is a narrow side
 * panel, so where the full pull request list fits reference and title on one line, this gives
 * each its own: reference and time, then the title, then who and where.
 */
export function LinkedItemRowLines({
  reference,
  referenceTooltip,
  updatedAt,
  status,
  title,
  signals,
  meta,
}: {
  /** `owner/repo#42`, cut in the middle so the number survives a long repository. */
  reference: string;
  /** How the item came to be linked, on hover over the reference. */
  referenceTooltip: ReactNode;
  updatedAt?: string | null | undefined;
  /** Right end of the first line, before the time: diff counts. */
  status?: ReactNode;
  title: ReactNode;
  /** Right after the title text: watch, checks and review verdict glyphs. */
  signals?: ReactNode;
  /** The third line: stack, author, branches or labels. */
  meta?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0 font-mono tabular-nums" />}>
            <MiddleTruncate value={reference} showTitle={false} />
          </TooltipTrigger>
          <TooltipPopup>{referenceTooltip}</TooltipPopup>
        </Tooltip>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {status}
          {updatedAt ? (
            <span className="whitespace-nowrap tabular-nums">
              {formatRelativeTimeLabel(updatedAt)}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm">{title}</span>
        {signals ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs">{signals}</span>
        ) : null}
      </span>
      {meta ? (
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The row's action menu, out of the row's flow so no row reserves a column for a button only the
 * hovered one shows. It sits over the right end of the first line on the row's own hover color,
 * fading in from the left, so it covers the time and leaves the title alone. The row needs the
 * `group/linked-row` class and `relative`.
 */
export function LinkedItemRowActions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "absolute top-0.5 right-0 flex items-center rounded-r-md bg-background pr-1 pl-5",
        "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
        // Hidden means untouchable too: on a touch screen there is no hover, and an invisible
        // layer over the right of the row would otherwise swallow the tap meant for the link.
        "pointer-events-none opacity-0 group-hover/linked-row:pointer-events-auto group-hover/linked-row:opacity-100",
        "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
        "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
      )}
    >
      <span aria-hidden className="absolute inset-0 bg-accent/60" />
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-micro" aria-label={label} className="relative">
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom">
          {children}
        </MenuPopup>
      </Menu>
    </span>
  );
}

/** Row container classes: the hover group the actions overlay listens to. */
export const LINKED_ITEM_ROW_CLASS =
  "group/linked-row relative flex w-full items-start gap-2 rounded-md py-1 pr-1 text-left hover:bg-accent/60";
