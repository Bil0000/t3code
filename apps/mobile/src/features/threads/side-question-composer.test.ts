import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("./ThreadDetailScreen.tsx", import.meta.url), "utf8");

describe("side question composer", () => {
  it("submits a follow-up when Return is pressed", () => {
    const input = source.match(
      /<TextInput\s+multiline[\s\S]*?accessibilityLabel="Ask a follow-up side question"[\s\S]*?\/>/,
    )?.[0];

    expect(input).toBeDefined();
    expect(input).toContain('submitBehavior="submit"');
    expect(input).toContain("onSubmitEditing=");
    expect(input).toContain("submitSideQuestion");
  });
});
