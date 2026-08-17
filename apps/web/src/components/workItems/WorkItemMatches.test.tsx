import type { WorkItemMatch } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkItemMatchButton, WorkItemMatchRows } from "./WorkItemMatches";

const match = {
  kind: "pull-request",
  provider: "github",
  repository: "acme/app",
  number: 34,
  title: "Refresh active sessions",
  url: "https://github.com/acme/app/pull/34",
  confidence: "high",
  reason: "Implements the session refresh requested here.",
} satisfies WorkItemMatch;

describe("work item matches", () => {
  it("shows progress while AI is finding matches", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchButton busy loaded={false} onClick={() => undefined} />,
    );

    expect(markup).toContain("Finding...");
  });

  it("shows trusted match details and confidence", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchRows
        matches={[match]}
        emptyText="No likely matches found."
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Refresh active sessions");
    expect(markup).toContain("Implements the session refresh requested here.");
    expect(markup).toContain("High confidence");
  });

  it("shows a clear empty result", () => {
    const markup = renderToStaticMarkup(
      <WorkItemMatchRows
        matches={[]}
        emptyText="No likely duplicate issues found."
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("No likely duplicate issues found.");
  });
});
