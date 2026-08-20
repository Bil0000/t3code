import type { VcsHistoryRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildGitRefTree, filterGitRefTree } from "./gitRefTree";

function ref(name: string, options?: { current?: boolean; isDefault?: boolean }): VcsHistoryRef {
  return {
    name,
    current: options?.current ?? false,
    isDefault: options?.isDefault ?? false,
    worktreePath: null,
  };
}

describe("buildGitRefTree", () => {
  it("groups slash-delimited refs and pins current and default branches", () => {
    const tree = buildGitRefTree([
      ref("development"),
      ref("feat/two"),
      ref("merge-wt", { current: true }),
      ref("feat/one"),
      ref("master", { isDefault: true }),
    ]);

    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["ref", "merge-wt"],
      ["ref", "master"],
      ["folder", "feat"],
      ["ref", "development"],
    ]);
    expect(tree[2]).toMatchObject({
      kind: "folder",
      path: "feat",
      children: [
        { kind: "ref", name: "one" },
        { kind: "ref", name: "two" },
      ],
    });
  });

  it("preserves matching ancestors while filtering by full ref name", () => {
    const tree = buildGitRefTree([ref("chore/review/hardening"), ref("feat/map")]);
    expect(filterGitRefTree(tree, "hardening")).toMatchObject([
      {
        kind: "folder",
        name: "chore",
        children: [
          {
            kind: "folder",
            name: "review",
            children: [{ kind: "ref", name: "hardening" }],
          },
        ],
      },
    ]);
  });
});
