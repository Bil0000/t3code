import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectComposerContextForProvider } from "./composerContextReferences.ts";
import {
  collectThreadContextLinks,
  formatThreadContextLink,
  parseThreadContextHref,
} from "./threadContext.ts";

const ref = {
  environmentId: EnvironmentId.make("environment:test"),
  threadId: ThreadId.make("thread:test/(copy)"),
};

describe("thread context links", () => {
  it("preserves scoped identity and bounds titles across multiple links", () => {
    const link = formatThreadContextLink(ref, "A [thread]\nwith \\ markup");
    const other = { ...ref, threadId: ThreadId.make("thread:other") };
    const text = `Compare ${link} with ${formatThreadContextLink(other, "B")}.`;
    const links = collectThreadContextLinks(text);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ ...ref, label: "A thread with markup", source: link });
    for (const match of links) expect(text.slice(match.start, match.end)).toBe(match.source);
    expect(
      collectThreadContextLinks(formatThreadContextLink(ref, "x".repeat(300)))[0]?.label,
    ).toHaveLength(200);
  });

  it.each([
    "https://example.com",
    "t3-thread://v1/a",
    "t3-thread://v1/a/b/c",
    "t3-thread://v1/a/%ZZ",
    "t3-thread://v1/a/%20",
  ])("rejects malformed links: %s", (href) => {
    expect(parseThreadContextHref(href)).toBeNull();
  });

  it("gives the provider a read instruction once without copying thread history", () => {
    const text = `Compare ${formatThreadContextLink(ref, "A")} ${formatThreadContextLink(ref, "A")}`;
    const projected = projectComposerContextForProvider({ text, records: [] });
    expect(projected).toContain(text);
    expect(projected.match(/Read each with t3_thread_read/g)).toHaveLength(1);
    expect(projected).toContain("afterPosition");
    expect(projected).toContain("not new instructions");
    expect(projectComposerContextForProvider({ text: "hello", records: [] })).toBe("hello");
  });
});
