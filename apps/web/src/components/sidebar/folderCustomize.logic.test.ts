import { ThreadFolderId, type ThreadFolderRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addRulePattern,
  buildFolderUpdate,
  folderRuleDraft,
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
  rule: folderRuleDraft(folder.rule),
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
      { ...unchanged, rule: folderRuleDraft(null) },
      { type: "folder.update", folderId, rule: null, autoFile: false },
    ],
    [
      "rule changed keeps the opt-out",
      { ...unchanged, autoFile: false, rule: { ...unchanged.rule, pullRequest: true } },
      {
        type: "folder.update",
        folderId,
        rule: { branches: ["feat/*"], pullRequest: true },
        autoFile: false,
      },
    ],
  ] as const)("%s", (_label, draft, expected) => {
    expect(buildFolderUpdate(folder, draft)).toEqual(expected);
  });

  it("sends nothing for auto-file alone when there is no rule", () => {
    const ruleless = { ...folder, rule: null, autoFile: false };
    expect(
      buildFolderUpdate(ruleless, { ...unchanged, rule: folderRuleDraft(null), autoFile: true }),
    ).toBeNull();
  });
});

describe("addRulePattern", () => {
  it("trims, skips blanks and case-insensitive duplicates", () => {
    expect(addRulePattern([], "  main ")).toEqual(["main"]);
    expect(addRulePattern(["main"], "MAIN")).toEqual(["main"]);
    expect(addRulePattern(["main"], "   ")).toEqual(["main"]);
    expect(
      addRulePattern(
        Array.from({ length: 20 }, (_, i) => `b${i}`),
        "x",
      ),
    ).toHaveLength(20);
  });
});
