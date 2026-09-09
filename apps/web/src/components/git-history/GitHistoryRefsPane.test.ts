import type { VcsHistoryRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildGitRefTree } from "../../lib/gitRefTree";
import { buildRefPaneRows } from "./GitHistoryRefsPane";

function ref(name: string, isTag = false): VcsHistoryRef {
  return {
    current: false,
    isDefault: false,
    isRemote: false,
    ...(isTag ? { isTag: true } : {}),
    name,
    worktreePath: null,
  };
}

describe("buildRefPaneRows", () => {
  it("keeps a large expanded tag hierarchy as list data instead of render items", () => {
    const rows = buildRefPaneRows({
      localRefTree: [],
      favoriteRefs: [],
      remoteRefTree: [],
      tagRefTree: buildGitRefTree(
        Array.from({ length: 10_000 }, (_, index) => ref(`release/${index}`, true)),
      ),
      expandedRefKeys: new Set(["section:local", "section:tags", "tags:release"]),
      filterActive: false,
      hasMoreRefs: false,
      refPaginationError: null,
    });

    expect(rows).toHaveLength(10_006);
    expect(rows.filter((row) => row.kind === "ref")).toHaveLength(10_000);
    expect(rows.find((row) => row.key === "section:tags")).toMatchObject({
      count: 10_000,
      open: true,
    });
  });

  it("opens tag descendants while filtering without changing folder keys", () => {
    const rows = buildRefPaneRows({
      localRefTree: [],
      favoriteRefs: [],
      remoteRefTree: [],
      tagRefTree: buildGitRefTree([ref("release/v1", true)]),
      expandedRefKeys: new Set(),
      filterActive: true,
      hasMoreRefs: false,
      refPaginationError: null,
    });

    expect(rows.map((row) => row.key)).toContain("tags:release");
    expect(rows.map((row) => row.key)).toContain("refs/tags/release/v1");
  });

  it("projects loaded favorite local refs before their canonical Local rows", () => {
    const favorite = ref("feature/favorite");
    const rows = buildRefPaneRows({
      localRefTree: buildGitRefTree([favorite]),
      favoriteRefs: [favorite],
      remoteRefTree: [],
      tagRefTree: [],
      expandedRefKeys: new Set(["section:local", "local:feature"]),
      filterActive: false,
      hasMoreRefs: false,
      refPaginationError: null,
    });

    expect(rows.map((row) => row.key)).toEqual([
      "all",
      "current",
      "favorite:refs/heads/feature/favorite",
      "section:local",
      "local:feature",
      "refs/heads/feature/favorite",
      "section:remote",
      "section:tags",
    ]);
    expect(rows[2]).toMatchObject({ node: { name: "feature/favorite" } });
  });
});
