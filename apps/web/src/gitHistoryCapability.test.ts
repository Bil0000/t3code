import { describe, expect, it } from "vite-plus/test";

import { hasGitHistoryCapability } from "./gitHistoryCapability";

describe("Git History capability", () => {
  it("treats only an explicit true flag as supported", () => {
    expect(hasGitHistoryCapability(undefined)).toBe(false);
    expect(hasGitHistoryCapability({})).toBe(false);
    expect(hasGitHistoryCapability({ gitHistory: false })).toBe(false);
    expect(hasGitHistoryCapability({ gitHistory: true })).toBe(true);
  });
});
