import type { IssueRelativeNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { flattenIssueTree, mergeIssueTrees } from "./IssueTree";

function issue(number: number, subIssues: Array<IssueRelativeNode> = []): IssueRelativeNode {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://linear.app/acme/issue/ENG-${number}`,
    state: "open",
    subIssues,
  };
}

describe("issue tree", () => {
  const root = {
    ...issue(2, [issue(3, [issue(5)]), issue(4)]),
    ancestors: [issue(0), issue(1)],
  };

  it("lists ancestors, the issue, then sub-issues depth-first", () => {
    expect(flattenIssueTree(root).map((row) => [row.issue.number, row.depth, row.current])).toEqual(
      [
        [0, 0, false],
        [1, 1, false],
        [2, 2, true],
        [3, 3, false],
        [5, 4, false],
        [4, 3, false],
      ],
    );
  });
});

describe("merged issue trees", () => {
  const scope = "linear:ENG";
  const epic = { ...issue(94, [issue(96), issue(95)]), ancestors: [issue(97)] };
  const sibling = {
    ...issue(101),
    ancestors: [issue(97)],
    linkedPullRequests: [
      {
        repository: "acme/web",
        number: 751,
        title: "Hello",
        url: "https://github.com/acme/web/pull/751",
        state: "open" as const,
        isDraft: true,
        closesIssue: true,
      },
    ],
  };
  const child = { ...issue(96), ancestors: [issue(97), issue(94)] };

  it("puts linked issues under a shared ancestor in one tree, each where it sits", () => {
    const [tree, ...rest] = mergeIssueTrees([
      { scope, linkKey: "a", detail: epic },
      { scope, linkKey: "b", detail: sibling },
      { scope, linkKey: "c", detail: child },
    ]);
    expect(rest).toEqual([]);
    expect(tree!.rows.map((row) => [row.issue.number, row.depth, row.linkKey])).toEqual([
      [97, 0, null],
      [94, 1, "a"],
      [96, 2, "c"],
      [95, 2, null],
      [101, 1, "b"],
    ]);
    expect(tree!.rows.at(-1)!.issue.linkedPullRequests?.[0]?.number).toBe(751);
  });

  it("keeps trees of different tracker projects apart", () => {
    expect(
      mergeIssueTrees([
        { scope, linkKey: "a", detail: epic },
        { scope: "linear:OPS", linkKey: "b", detail: sibling },
      ]),
    ).toHaveLength(2);
  });
});
