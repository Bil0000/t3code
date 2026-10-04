import { parseClaudeContextReport } from "./claudeContextReport.ts";

export { parseClaudeContextReport as parseContextReport } from "./claudeContextReport.ts";

export interface ContextCategory {
  readonly name: string;
  readonly tokens: string;
  readonly percent: number;
}

export interface ContextSection {
  readonly title: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly totalTokens: number | null;
}

export interface ContextReport {
  readonly model: string | null;
  readonly usedTokens: string;
  readonly maxTokens: string;
  readonly usedPercent: number;
  readonly overLimit: string | null;
  readonly categories: ReadonlyArray<ContextCategory>;
  readonly sections: ReadonlyArray<ContextSection>;
}

const FREE_SPACE_CATEGORIES = new Set(["Free space", "Autocompact buffer"]);

export function contextReportFromUsage(
  usage:
    | { readonly usedTokens: number; readonly maxTokens?: number | null | undefined }
    | null
    | undefined,
  model: string | null = null,
): ContextReport | null {
  if (
    !usage ||
    !Number.isSafeInteger(usage.usedTokens) ||
    usage.usedTokens < 0 ||
    usage.maxTokens == null ||
    !Number.isSafeInteger(usage.maxTokens) ||
    usage.maxTokens <= 0
  ) {
    return null;
  }
  return {
    model,
    usedTokens: formatContextTokens(usage.usedTokens),
    maxTokens: formatContextTokens(usage.maxTokens),
    usedPercent: (usage.usedTokens / usage.maxTokens) * 100,
    overLimit:
      usage.usedTokens > usage.maxTokens
        ? `${formatContextTokens(usage.usedTokens - usage.maxTokens)} tokens over`
        : null,
    categories: [],
    sections: [],
  };
}

export function latestContextReport(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>,
): { readonly id: string; readonly report: ContextReport } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return null;
    if (message.role !== "assistant" || message.streaming) continue;
    const report = parseClaudeContextReport(message.text);
    if (report) return { id: message.id, report };
  }
  return null;
}

export function formatContextHeadline(report: ContextReport): string {
  return `${report.usedTokens} / ${report.maxTokens} (${formatContextPercent(report.usedPercent)})`;
}

export function contextUsedCategories(report: ContextReport): ReadonlyArray<ContextCategory> {
  return report.categories.filter((category) => !FREE_SPACE_CATEGORIES.has(category.name));
}

export function formatContextPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/u, "")}%` : `${Math.round(value)}%`;
}

export function formatContextTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

export function contextSegmentColor(index: number, count: number): string {
  return `hsl(${Math.round((index / Math.max(count, 1)) * 300)} 55% 58%)`;
}
