import { describe, expect, it } from "vite-plus/test";

import type {
  OrchestrationV2ProviderTurnTokenUsage,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

import {
  contextReportFromUsage,
  contextUsedCategories,
  formatContextHeadline,
  formatContextPercent,
  parseContextReport,
  type ContextReport,
} from "./contextReport.ts";

describe("contextReportFromUsage", () => {
  it("shows current Codex usage without inventing a category breakdown", () => {
    const usage: ThreadTokenUsageSnapshot = {
      usedTokens: 64_600,
      maxTokens: 258_400,
      totalProcessedTokens: 999_000,
      inputTokens: 60_000,
      outputTokens: 4_600,
      cachedInputTokens: 50_000,
    };
    const report = contextReportFromUsage(usage, "gpt-6.1-sol");
    expect(report).toEqual({
      model: "gpt-6.1-sol",
      usedTokens: "65k",
      maxTokens: "258k",
      usedPercent: 25,
      overLimit: null,
      categories: [],
      sections: [],
    });
    expect(formatContextHeadline(report!)).toBe("65k / 258k (25%)");
  });

  it("accepts V2 turn usage with nullable capacity", () => {
    const usage: OrchestrationV2ProviderTurnTokenUsage = {
      usedTokens: 40_000,
      maxTokens: 200_000,
      updatedAt: "2026-10-04T12:00:00.000Z",
    };
    expect(contextReportFromUsage(usage)).toMatchObject({ usedPercent: 20 });
    expect(contextReportFromUsage({ ...usage, maxTokens: null })).toBeNull();
  });

  it("keeps zero usage and over-limit usage", () => {
    expect(contextReportFromUsage({ usedTokens: 0, maxTokens: 200_000 })).toMatchObject({
      usedTokens: "0",
      usedPercent: 0,
      model: null,
    });
    expect(contextReportFromUsage({ usedTokens: 210_000, maxTokens: 200_000 })).toMatchObject({
      usedPercent: 105,
      overLimit: "10k tokens over",
    });
  });

  it.each([
    undefined,
    null,
    { usedTokens: 1_000 },
    { usedTokens: 1_000, maxTokens: null },
    { usedTokens: 1_000, maxTokens: 0 },
    { usedTokens: 1_000, maxTokens: -1 },
    { usedTokens: 1_000, maxTokens: Number.POSITIVE_INFINITY },
    { usedTokens: 1_000, maxTokens: 100.5 },
    { usedTokens: -1, maxTokens: 200_000 },
    { usedTokens: Number.NaN, maxTokens: 200_000 },
    { usedTokens: 100.5, maxTokens: 200_000 },
  ])("returns null for unavailable or invalid bounds: %j", (usage) => {
    expect(contextReportFromUsage(usage)).toBeNull();
  });
});

describe("normalized reports", () => {
  it("formats reports from other harnesses with their own categories and tables", () => {
    const report: ContextReport = {
      model: "other-model",
      usedTokens: "40k",
      maxTokens: "100k",
      usedPercent: 40,
      overLimit: null,
      categories: [
        { name: "Instructions", tokens: "10k", percent: 10 },
        { name: "Conversation", tokens: "30k", percent: 30 },
        { name: "Free space", tokens: "60k", percent: 60 },
      ],
      sections: [{ title: "Files", columns: ["Path"], rows: [["AGENTS.md"]], totalTokens: null }],
    };
    expect(formatContextHeadline(report)).toBe("40k / 100k (40%)");
    expect(contextUsedCategories(report).map((category) => category.name)).toEqual([
      "Instructions",
      "Conversation",
    ]);
  });
});

describe("text reports", () => {
  const text = "## Context Usage\n\n**Tokens:** 10k / 200k (5%)";

  it("uses the Claude adapter and preserves unrecognized Markdown", () => {
    expect(parseContextReport(text)).toMatchObject({ usedTokens: "10k", usedPercent: 5 });
    expect(parseContextReport(`${text}\nExplanation`)).toBeNull();
    expect(parseContextReport("Context: 10k / 200k")).toBeNull();
  });
});

describe("formatContextPercent", () => {
  it.each([
    [0, "0%"],
    [0.2, "0.2%"],
    [9.54, "9.5%"],
    [40.5, "41%"],
    [105, "105%"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatContextPercent(value)).toBe(expected);
  });
});
