import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  parseSideQuestion,
  sideQuestionCancellationSucceeded,
  sideQuestionPreviousTurns,
} from "./orchestration.ts";

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

describe("sideQuestionCancellationSucceeded", () => {
  it("only accepts a confirmed cancellation", () => {
    expect(sideQuestionCancellationSucceeded(AsyncResult.success({ cancelled: true }))).toBe(true);
    expect(sideQuestionCancellationSucceeded(AsyncResult.success({ cancelled: false }))).toBe(
      false,
    );
    expect(
      sideQuestionCancellationSucceeded(AsyncResult.failure(Cause.fail(new Error("offline")))),
    ).toBe(false);
  });
});
