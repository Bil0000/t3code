import { describe, expect, it } from "vite-plus/test";
import { resolveScheduledTaskBaseRef } from "./ScheduledTasksSettings.logic";

describe("scheduled task base ref", () => {
  const refs = [
    { name: "feature/test", isDefault: false },
    { name: "develop", isDefault: true },
  ];

  it("uses the repository default instead of main or the current branch", () => {
    expect(resolveScheduledTaskBaseRef("", refs)).toBe("develop");
    expect(resolveScheduledTaskBaseRef("", [{ name: "origin/develop", isDefault: true }])).toBe(
      "origin/develop",
    );
  });

  it("keeps an explicit ref and does not guess while refs are unavailable", () => {
    expect(resolveScheduledTaskBaseRef(" release ", refs)).toBe("release");
    expect(resolveScheduledTaskBaseRef("", [])).toBe("");
    expect(resolveScheduledTaskBaseRef("", [{ name: "feature/test", isDefault: false }])).toBe("");
  });
});
