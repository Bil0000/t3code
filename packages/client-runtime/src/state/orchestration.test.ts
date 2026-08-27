import { describe, expect, it } from "vite-plus/test";

import { parseSideQuestion, sideQuestionPreviousTurns } from "./orchestration.ts";

describe("parseSideQuestion", () => {
  it("parses the exact /btw command and preserves a multi-line question", () => {
    expect(parseSideQuestion("/btw What failed?\nGive me the short version.")).toBe(
      "What failed?\nGive me the short version.",
    );
    expect(parseSideQuestion("/btw")).toBe("");
  });

  it("leaves lookalike commands in the main conversation", () => {
    expect(parseSideQuestion("/btwice explain this")).toBeNull();
    expect(parseSideQuestion("Please /btw explain this")).toBeNull();
  });
});

describe("sideQuestionPreviousTurns", () => {
  it("keeps the latest 50 successful turns", () => {
    const turns = Array.from({ length: 52 }, (_, index) => ({
      question: `Question ${index}`,
      answer: `Answer ${index}`,
      status: "success",
    }));

    expect(sideQuestionPreviousTurns(turns)).toEqual(
      turns.slice(2).map(({ question, answer }) => ({ question, answer })),
    );
  });
});
