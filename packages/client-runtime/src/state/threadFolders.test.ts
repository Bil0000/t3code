import { EnvironmentId, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type EnvironmentThreadFolder,
  layoutThreadFolders,
  resolveFolderReorder,
} from "./threadFolders.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ThreadId.make(id),
});
const folder = (
  environmentId: EnvironmentId,
  id: string,
  threadIds: ReadonlyArray<string>,
): EnvironmentThreadFolder => ({
  environmentId,
  id: ThreadFolderId.make(id),
  name: id,
  icon: null,
  rule: null,
  autoFile: false,
  ruleSetAt: null,
  threadIds: threadIds.map((id) => ThreadId.make(id)),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("layoutThreadFolders", () => {
  it("keeps thread order inside folders, keeps empty folders, and scopes membership by environment", () => {
    const threads = [
      thread(local, "b"),
      thread(remote, "a"),
      thread(local, "a"),
      thread(local, "c"),
    ];
    const layout = layoutThreadFolders({
      threads,
      folders: [folder(local, "reviews", ["a", "b", "missing"]), folder(local, "empty", [])],
    });
    expect(layout.blocks.map((block) => [block.key, block.threads.map((t) => t.id)])).toEqual([
      ["local:reviews", ["b", "a"]],
      ["local:empty", []],
    ]);
    expect(layout.unfiled.map((t) => `${t.environmentId}:${t.id}`)).toEqual([
      "remote:a",
      "local:c",
    ]);
  });
});

describe("resolveFolderReorder", () => {
  it.each([
    [0, { beforeFolderId: "a" }],
    [1, null],
    [2, null],
    [3, { beforeFolderId: "d" }],
    [4, { beforeFolderId: null }],
  ])("drops b at slot %i", (index, expected) => {
    expect(resolveFolderReorder(["a", "b", "c", "d"], ["a", "b", "c", "d"], "b", index)).toEqual(
      expected,
    );
  });

  it("orders within the section the folder shows in", () => {
    const order = ["settled", "b", "c", "late"];
    expect(resolveFolderReorder(order, ["b", "c"], "b", 2)).toEqual({ beforeFolderId: "late" });
    expect(resolveFolderReorder(order, ["c", "b"], "b", 0)).toEqual({ beforeFolderId: "c" });
  });
});
