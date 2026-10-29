import { ThreadFolderId, type ThreadFolderRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFolderUpdate,
  folderRuleEditor,
  folderRuleFromEditor,
  type FolderCustomizeDraft,
} from "./folderCustomize.logic";

const folderId = ThreadFolderId.make("folder-1");
const branchRule: ThreadFolderRule = { branches: ["feat/*"] };
const folder = {
  id: folderId,
  name: "Reviews",
  icon: { kind: "lucide", name: "eye", color: "blue" },
  rule: branchRule,
  autoFile: true,
} as const;
const unchanged: FolderCustomizeDraft = {
  name: folder.name,
  icon: folder.icon,
  rule: branchRule,
  autoFile: true,
};

describe("buildFolderUpdate", () => {
  it.each([
    ["nothing changed", unchanged, null],
    ["blank name is ignored", { ...unchanged, name: "  " }, null],
    ["renamed", { ...unchanged, name: " PRs " }, { type: "folder.update", folderId, name: "PRs" }],
    ["icon removed", { ...unchanged, icon: null }, { type: "folder.update", folderId, icon: null }],
    [
      "auto-file turned off",
      { ...unchanged, autoFile: false },
      { type: "folder.update", folderId, autoFile: false },
    ],
    [
      "rule emptied clears it",
      { ...unchanged, rule: null },
      { type: "folder.update", folderId, rule: null, autoFile: false },
    ],
    [
      "rule changed keeps the opt-out",
      { ...unchanged, autoFile: false, rule: { smart: true } },
      { type: "folder.update", folderId, rule: { smart: true }, autoFile: false },
    ],
  ] as const)("%s", (_label, draft, expected) => {
    expect(buildFolderUpdate(folder, draft)).toEqual(expected);
  });

  it("sends nothing for auto-file alone when there is no rule", () => {
    const ruleless = { ...folder, rule: null, autoFile: false };
    expect(buildFolderUpdate(ruleless, { ...unchanged, rule: null, autoFile: true })).toBeNull();
  });
});

describe("folderRuleEditor", () => {
  it.each([
    [null, { mode: "name", pattern: "" }],
    [{ smart: true }, { mode: "name", pattern: "" }],
    [{ branches: ["feat/*"] }, { mode: "branch", pattern: "feat/*" }],
    [{ worktrees: ["t3-1"] }, { mode: "worktree", pattern: "t3-1" }],
    [{ branches: ["a", "b"] }, null],
    [{ branches: ["a"], pullRequest: true }, null],
    [{ titleKeywords: ["review"] }, null],
  ] as const)("%j", (rule, expected) => {
    expect(folderRuleEditor(rule)).toEqual(expected);
  });
});

describe("folderRuleFromEditor", () => {
  it("saves a smart rule by name and drops a blank pattern", () => {
    expect(folderRuleFromEditor("name", "")).toEqual({ smart: true });
    expect(folderRuleFromEditor("branch", " feat/* ")).toEqual({ branches: ["feat/*"] });
    expect(folderRuleFromEditor("worktree", "  ")).toBeNull();
  });
});
