import type { PullRequestStackStep, PullRequestStackSummary } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  Clock3Icon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function StepIcon({ step }: { step: PullRequestStackStep }) {
  const className = "size-3.5 shrink-0";
  if (step.state === "merged") {
    return <CheckCircle2Icon aria-label="Merged" className={cn(className, "text-emerald-500")} />;
  }
  if (step.state === "queued") {
    return <Clock3Icon aria-label="Queued" className={cn(className, "text-blue-500")} />;
  }
  if (step.state === "closed") {
    return (
      <GitPullRequestClosedIcon aria-label="Closed" className={cn(className, "text-red-500")} />
    );
  }
  if (step.draft) {
    return (
      <GitPullRequestDraftIcon
        aria-label="Draft"
        className={cn(className, "text-muted-foreground")}
      />
    );
  }
  return <CircleDotIcon aria-label="Open" className={cn(className, "text-emerald-500")} />;
}

export function PullRequestStackPicker({
  stack,
  pullRequestNumber,
  onSelect,
}: {
  stack: PullRequestStackSummary;
  pullRequestNumber: number;
  onSelect?: (pullRequestNumber: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = stack.steps.find((step) => step.pullRequestNumber === pullRequestNumber);
  if (current === undefined) return null;
  const previous = stack.steps.find((step) => step.position === current.position - 1);
  const next = stack.steps.find((step) => step.position === current.position + 1);
  const openCount = stack.steps.filter((step) => step.state === "open").length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open pull request stack. Step ${current.position} of ${stack.steps.length}.`}
      >
        <LayersIcon aria-hidden className="size-3.5 text-emerald-500" />
        <span className="tabular-nums">
          {current.position}/{stack.steps.length}
        </span>
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-96 max-w-[calc(100vw-1rem)]">
        <div className="mb-3 flex items-center gap-2">
          <LayersIcon aria-hidden className="size-4 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Pull request stack</p>
            <p className="truncate text-xs text-muted-foreground">
              {openCount} open · {stack.steps.length} steps into {stack.baseBranch}
            </p>
          </div>
          <Badge variant="outline" className="text-[10px]">
            Stack #{stack.number}
          </Badge>
        </div>
        <ol className="relative space-y-1 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-border">
          {stack.steps.toReversed().map((step) => {
            const selected = step.pullRequestNumber === pullRequestNumber;
            return (
              <li key={step.pullRequestNumber} className="relative">
                <button
                  type="button"
                  aria-current={selected ? "step" : undefined}
                  onClick={() => {
                    setOpen(false);
                    onSelect?.(step.pullRequestNumber);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <span className="relative z-10 grid size-4 shrink-0 place-items-center bg-popover">
                    <StepIcon step={step} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{step.branch}</span>
                  {step.draft ? (
                    <span className="text-[10px] text-muted-foreground">Draft</span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    #{step.pullRequestNumber}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          <span className="size-2 rounded-full border border-border bg-background" />
          <span className="min-w-0 flex-1 truncate">{stack.baseBranch}</span>
          {onSelect ? (
            <div className="flex gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={!previous}
                onClick={() => {
                  setOpen(false);
                  if (previous) onSelect(previous.pullRequestNumber);
                }}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!next}
                onClick={() => {
                  setOpen(false);
                  if (next) onSelect(next.pullRequestNumber);
                }}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
