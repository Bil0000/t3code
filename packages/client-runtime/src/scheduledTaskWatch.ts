import type {
  ScheduledTask,
  ScheduledTaskWatch,
  ScheduledTaskWatchFilter,
  ScheduledTaskWatchSource,
} from "@t3tools/contracts";

import { WEBHOOK_FILTER_OPS } from "./scheduledTaskWebhook.ts";

export type ScheduledTaskWithWatch = ScheduledTask & { readonly watch: ScheduledTaskWatch };

export function isWatchTask(task: ScheduledTask): task is ScheduledTaskWithWatch {
  return task.watch !== undefined;
}

export function watchSourceLabel(source: ScheduledTaskWatchSource): string {
  const kind = source.type === "jira" ? "Jira" : "JSON feed";
  try {
    return `${kind} · ${new URL(source.type === "jira" ? source.baseUrl : source.url).host}`;
  } catch {
    return kind;
  }
}

function filterLabel(filter: ScheduledTaskWatchFilter): string {
  const op = WEBHOOK_FILTER_OPS.find((entry) => entry.op === filter.op)?.label ?? filter.op;
  if (filter.op === "exists") return `${filter.path} ${op}`;
  const value = filter.op === "in" ? filter.value.join(", ") : filter.value;
  return `${filter.path} ${op} ${value}`;
}

export function watchRuleLabel(filters: ReadonlyArray<ScheduledTaskWatchFilter>): string {
  const [first, ...rest] = filters;
  if (!first) return "Any new item";
  return rest.length > 0 ? `${filterLabel(first)} +${rest.length} more` : filterLabel(first);
}

export type WatchStatusTone = "muted" | "error" | "info" | "success";

export function watchStatus(task: ScheduledTaskWithWatch): {
  readonly label: string;
  readonly tone: WatchStatusTone;
} {
  if (!task.enabled) return { label: "Paused", tone: "muted" };
  if (task.lastRunStatus === "failed") return { label: "Check failed", tone: "error" };
  if (task.watch.initializedAt === null) return { label: "Setting baseline", tone: "info" };
  return { label: "Watching", tone: "success" };
}

export function watchActivityLabel(watch: ScheduledTaskWatch): string {
  const runs = `${watch.fireCount} ${watch.fireCount === 1 ? "run" : "runs"} started`;
  return [
    watch.activeRunCount > 0
      ? `${watch.activeRunCount} of ${watch.maxConcurrentRuns} running`
      : null,
    watch.pendingCount > 0 ? `${watch.pendingCount} queued` : null,
    runs,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
