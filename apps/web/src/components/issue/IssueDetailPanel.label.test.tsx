import { describe, expect, it } from "vite-plus/test";

import { openOnIssueLabel } from "./IssueDetailPanel";

describe("issue detail provider labels", () => {
  it("uses the provider presentation name for Linear", () => {
    expect(openOnIssueLabel("linear")).toBe("Open on Linear");
  });
});
