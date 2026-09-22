import { parseClaudeContextReport } from "@t3tools/shared/claudeContextReport";
import { act } from "react";
import { create, type ReactTestRendererNode } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeContextCard } from "./ClaudeContextCard";

const REPORT = `## Context Usage

**Model:** claude-sonnet-5
**Tokens:** 79.5k / 200k (40%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.8k | 2.4% |
| Messages | 4.6k | 2.3% |
| Free space | 87.5k | 43.7% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__github__add_issue_comment | github | 81 |
| mcp__github__create_branch | github | 1.1k |
`;

function textOf(renderer: ReturnType<typeof create>): string {
  const walk = (node: ReactTestRendererNode | ReactTestRendererNode[] | null): string =>
    node === null
      ? ""
      : Array.isArray(node)
        ? node.map(walk).join("")
        : typeof node === "string"
          ? node
          : `${node.props["aria-valuenow"] === undefined ? "" : `[${node.props["aria-valuenow"]}]`}${walk(node.children)}`;
  return walk(renderer.toJSON());
}

describe("ClaudeContextCard", () => {
  it("starts collapsed with the headline and bar, then expands categories and sections", () => {
    const report = parseClaudeContextReport(REPORT)!;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ClaudeContextCard report={report} />);
    });

    expect(textOf(renderer)).toContain("79.5k / 200k (40%)");
    expect(textOf(renderer)).toContain("[40]");
    expect(textOf(renderer)).not.toContain("System prompt");
    expect(textOf(renderer)).not.toContain("mcp__github__add_issue_comment");

    const [header] = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-expanded"] === false,
    );
    act(() => header!.props.onClick());
    expect(textOf(renderer)).toContain("System prompt");
    expect(textOf(renderer)).toContain("MCP Tools");
    expect(textOf(renderer)).toContain("1.2k · 2");
    expect(textOf(renderer)).not.toContain("mcp__github__add_issue_comment");

    const section = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-expanded"] === false,
    );
    act(() => section[0]!.props.onClick());
    expect(textOf(renderer)).toContain("mcp__github__add_issue_comment");
  });
});
