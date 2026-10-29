import { EnvironmentId, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type EnvironmentThreadFolder,
  layoutThreadFolders,
  resolveFolderReorder,
  threadFolderCollect,
  threadFolderCollectChoices,
  threadFolderCollectUpdate,
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

describe("threadFolderCollect", () => {
  const base = folder(local, "f", []);
  it.each([
    [null, true, { by: "off" }],
    [{ smart: true }, false, { by: "off" }],
    [{ smart: true }, true, { by: "topic" }],
    [{ branches: ["feat/*"] }, true, { by: "branch", value: "feat/*" }],
    [{ worktrees: ["t3-1"] }, true, { by: "worktree", value: "t3-1" }],
    [{ branches: ["a", "b"] }, true, { by: "custom" }],
    [{ smart: true, titleKeywords: ["x"] }, true, { by: "custom" }],
  ] as const)("%j autoFile=%s", (rule, autoFile, expected) => {
    expect(threadFolderCollect({ ...base, rule, autoFile })).toEqual(expected);
  });

  it("builds the update for a choice and skips the current one", () => {
    const topic = { ...base, rule: { smart: true }, autoFile: true };
    expect(threadFolderCollectUpdate(topic, { by: "topic" })).toBeNull();
    expect(threadFolderCollectUpdate(topic, { by: "off" })).toEqual({
      type: "folder.update",
      folderId: base.id,
      autoFile: false,
    });
    expect(threadFolderCollectUpdate(base, { by: "off" })).toBeNull();
    expect(threadFolderCollectUpdate(topic, { by: "branch", value: "main" })).toEqual({
      type: "folder.update",
      folderId: base.id,
      rule: { branches: ["main"] },
      autoFile: true,
    });
  });
});

describe("threadFolderCollectChoices", () => {
  const shell = (id: string, branch: string | null, worktreePath: string | null, at: string) => ({
    ...thread(local, id),
    branch,
    worktreePath,
    updatedAt: at,
    archivedAt: null,
  });
  it("lists the folder's own branches first, then recent ones, keeping the current value", () => {
    const choices = threadFolderCollectChoices(
      { ...folder(local, "f", ["member"]), rule: { branches: ["old/*"] }, autoFile: true },
      [
        shell("recent", "feat/b", "/w/t3-2/", "2026-01-03"),
        shell("member", "feat/a", "/w/t3-1", "2026-01-01"),
        shell("dupe", "feat/b", null, "2026-01-02"),
        { ...shell("remote", "remote", null, "2026-01-09"), environmentId: remote },
      ],
    );
    expect(choices).toEqual({
      branches: ["old/*", "feat/a", "feat/b"],
      worktrees: ["t3-1", "t3-2"],
    });
  });
});
