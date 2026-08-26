import { describe, expect, it } from "vite-plus/test";

import { parseSideQuestion } from "./orchestration.ts";

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
