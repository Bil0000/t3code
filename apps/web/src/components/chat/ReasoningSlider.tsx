import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/**
 * Reasoning selects are named differently per harness: Claude ships `effort`,
 * Codex `reasoningEffort`, Cursor `reasoning` (whose label comes from the CLI,
 * so it can read "Thinking Level" instead).
 */
const REASONING_DESCRIPTOR_IDS = new Set(["effort", "reasoning", "reasoningEffort"]);

export function isReasoningDescriptor(descriptor: SelectDescriptor): boolean {
  return (
    descriptor.options.length > 1 &&
    (REASONING_DESCRIPTOR_IDS.has(descriptor.id) ||
      /reasoning|effort|thinking/i.test(descriptor.label))
  );
}

/** Number of `--reasoning-N` stops declared in index.css, calmest first. */
const RAMP_STOPS = 8;

/**
 * Known level ids keep the same colour whatever the harness calls the model, so
 * "Max" reads the same red on Claude and Codex even though their option lists
 * differ in length. Unknown ids fall back to their position in the ramp.
 */
const LEVEL_RAMP_INDEX: Record<string, number> = {
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
  ultracode: 6,
  ultrathink: 7,
};

export function getReasoningRampIndex(optionId: string, index: number, total: number): number {
  const known = LEVEL_RAMP_INDEX[optionId.toLowerCase()];
  if (known !== undefined) {
    return known;
  }
  if (total <= 1) {
    return 0;
  }
  return Math.round((index / (total - 1)) * (RAMP_STOPS - 1));
}

export function getReasoningLevelColor(optionId: string, index: number, total: number): string {
  return `var(--reasoning-${getReasoningRampIndex(optionId, index, total) + 1})`;
}

/** Half the slider thumb, so the painted track lines up with the native value mapping. */
const TRACK_INSET = "0.5rem";

function stopOffset(index: number, total: number): string {
  const ratio = total > 1 ? index / (total - 1) : 0;
  return `calc(${TRACK_INSET} + (100% - ${TRACK_INSET} * 2) * ${ratio})`;
}

export interface ReasoningSliderProps {
  descriptor: SelectDescriptor;
  value: string;
  disabled?: boolean;
  badge?: ReactNode;
  onValueChange: (value: string) => void;
}

/**
 * Horizontal effort picker: drag, click, or arrow-key through the harness's
 * reasoning levels. A transparent native range input sits on top of the painted
 * track so pointer, touch, keyboard, and screen-reader support come for free.
 */
export function ReasoningSlider({
  descriptor,
  value,
  disabled = false,
  badge,
  onValueChange,
}: ReasoningSliderProps) {
  const options = descriptor.options;
  const total = options.length;
  const foundIndex = options.findIndex((option) => option.id === value);
  const selectedIndex = foundIndex >= 0 ? foundIndex : 0;
  const selected = options[selectedIndex];
  if (!selected) {
    return null;
  }
  const color = getReasoningLevelColor(selected.id, selectedIndex, total);
  const offset = stopOffset(selectedIndex, total);

  return (
    <div className="min-w-52 px-2 pt-1.5 pb-1" data-slot="reasoning-slider">
      <div className="flex items-center justify-between gap-3 pb-1.5">
        <span className="font-medium text-muted-foreground text-xs">{descriptor.label}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-xs" style={{ color }}>
            {selected.label}
          </span>
          {selected.isDefault ? badge : null}
        </span>
      </div>
      <div className={cn("relative flex h-5 items-center", disabled && "opacity-50")}>
        <div className="absolute right-2 left-2 h-1 rounded-full bg-foreground/15" />
        <div
          className="absolute left-2 h-1 rounded-full transition-[width] duration-100"
          style={{
            width: `calc((100% - ${TRACK_INSET} * 2) * ${total > 1 ? selectedIndex / (total - 1) : 1})`,
            background: `linear-gradient(90deg, var(--reasoning-1), ${color})`,
          }}
        />
        {options.map((option, index) => (
          <span
            key={option.id}
            className="-translate-x-1/2 absolute size-1 rounded-full bg-foreground/30"
            style={{ left: stopOffset(index, total) }}
          />
        ))}
        <span
          className="-translate-x-1/2 pointer-events-none absolute size-4 rounded-full border-2 border-popover shadow-sm transition-[left,background-color] duration-100"
          style={{ left: offset, backgroundColor: color }}
        />
        <input
          aria-label={descriptor.label}
          aria-valuetext={selected.label}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none"
          disabled={disabled}
          max={total - 1}
          min={0}
          onChange={(event) => {
            const next = options[Number(event.target.value)];
            if (next && next.id !== selected.id) {
              onValueChange(next.id);
            }
          }}
          // Base UI's menu owns arrow keys for item navigation; the slider needs
          // them for its own steps while it is focused.
          onKeyDown={(event) => {
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
              event.stopPropagation();
            }
          }}
          step={1}
          type="range"
          value={selectedIndex}
        />
      </div>
      <div className="flex items-center justify-between pt-0.5 text-[10px] text-muted-foreground/80">
        <span>{options[0]?.label}</span>
        <span>{options[total - 1]?.label}</span>
      </div>
    </div>
  );
}
