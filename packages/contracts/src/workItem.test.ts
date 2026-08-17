import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WorkItemMatchInput, WorkItemMatchResult } from "./workItem.ts";

const match = {
  kind: "issue" as const,
  provider: "linear",
  repository: "ENG",
  number: 12,
  title: "Sessions expire too early",
  url: "https://linear.app/acme/issue/ENG-12",
  confidence: "high" as const,
  reason: "Reports the same session expiry bug.",
};

describe("work item matches", () => {
  it("decodes a related-item request", () => {
    const decoded = Schema.decodeUnknownSync(WorkItemMatchInput)({
      projectId: "project-1",
      relationship: "related",
      source: { kind: "pull-request", repository: "acme/app", number: 34 },
    });

    expect(decoded.relationship).toBe("related");
  });

  it("rejects more than five visible suggestions", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemMatchResult)({ matches: Array(6).fill(match) }),
    ).toThrow();
  });
});
