import type { IssueCloseReason, IssueState, SourceControlLabel } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface StatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: typeof CircleDotIcon;
}

/**
 * How an issue's state reads on this page. Open and completed borrow the ink the pull request
 * states already use for open and merged, so green and violet mean the same thing on both
 * surfaces; not planned wears the grey a draft does, because work that stopped is not work that
 * finished and the two must not look alike.
 *
 * Only GitHub records why an issue was closed, so a closed issue with no reason reads as
 * completed — which is what closing one means everywhere that never asks.
 */
export function resolveIssueState(input: {
  readonly state: IssueState;
  readonly stateReason: IssueCloseReason | null;
}): StatePresentation {
  if (input.state === "open") {
    return {
      label: "Open",
      toneClassName: "text-emerald-600 dark:text-emerald-300/90",
      Icon: CircleDotIcon,
    };
  }
  if (input.stateReason === "not-planned") {
    return {
      label: "Closed as not planned",
      toneClassName: "text-zinc-500 dark:text-zinc-400/80",
      Icon: CircleSlashIcon,
    };
  }
  return {
    label: "Closed as completed",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: CircleCheckIcon,
  };
}

export function IssueStateGlyph({
  state,
  stateReason,
  className,
}: {
  state: IssueState;
  stateReason: IssueCloseReason | null;
  className?: string;
}) {
  const presentation = resolveIssueState({ state, stateReason });
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span: an interactive one would
          nest a control inside that button and steal the row's click target. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Hosts write a label colour every one of these ways, and none of them with an alpha channel. */
const HEX_COLOR_PATTERN = /^#?(?:([\da-f]{3})|([\da-f]{6}))$/iu;

function channels(color: string): { r: number; g: number; b: number } | null {
  const match = HEX_COLOR_PATTERN.exec(color.trim());
  if (match === null) return null;
  const hex =
    match[1] === undefined ? match[2]! : [...match[1]].map((digit) => `${digit}${digit}`).join("");
  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/**
 * Where black and white draw level against a background, by the WCAG contrast ratios — above it
 * black reads further, below it white does.
 */
const INK_CROSSOVER_LUMINANCE = 0.179;

/**
 * A label's own colours. The host picks the background and says nothing about the ink, and half
 * the palettes it offers are pale — GitHub ships `good first issue` as `#7057ff` beside a
 * `#d4c5f9` that white all but disappears on. So the ink is whichever of black and white the
 * background contrasts further with, rather than a fixed one.
 *
 * Nothing at all where the host gave no usable colour, which leaves the neutral chip standing.
 */
function labelStyle(color: string | null): CSSProperties | undefined {
  if (color === null) return undefined;
  const rgb = channels(color);
  if (rgb === null) return undefined;
  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return {
    backgroundColor: `#${color.trim().replace(/^#/u, "")}`,
    color: luminance > INK_CROSSOVER_LUMINANCE ? "#101014" : "#ffffff",
    borderColor: "transparent",
  };
}

/**
 * The labels a row wears, capped: an issue carrying nine of them would otherwise push everything
 * the row is about off its own line. What is left over is counted rather than dropped silently,
 * and named in the count's title so the reader can still find out what they were.
 */
export function IssueLabelChips({
  labels,
  max = 3,
  className,
}: {
  labels: ReadonlyArray<SourceControlLabel>;
  max?: number;
  className?: string;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const hidden = labels.slice(max);
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => (
        <span
          key={label.name}
          title={label.name}
          style={labelStyle(label.color)}
          className="max-w-28 shrink-0 truncate rounded-full border border-border/60 px-1.5 text-[10px] leading-4 font-medium"
        >
          {label.name}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className="shrink-0 text-[10px] text-muted-foreground/70"
          title={hidden.map((label) => label.name).join(", ")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
