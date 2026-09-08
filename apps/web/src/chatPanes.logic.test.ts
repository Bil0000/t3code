import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSplitPane,
  collectLeaves,
  removePane,
  resolveDropZone,
  selectChatPaneRoot,
  setPaneRatio,
  splitPane,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "./chatPanes.logic";

const leaf = (id: string): ChatPaneLeaf => ({
  kind: "leaf",
  id,
  threadRef: scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(`thread-${id}`)),
});
const allowAll = () => true;
const rect = { left: 0, top: 0, width: 300, height: 100 };

it("keeps a pane group intact while navigating outside it and back", () => {
  const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
  const other = splitPane(leaf("c"), "c", "right", leaf("d"), "s2");
  expect(selectChatPaneRoot([root, other], leaf("a").threadRef)).toBe(root);
  expect(selectChatPaneRoot([root, other], leaf("d").threadRef)).toBe(other);
  expect(selectChatPaneRoot([root], leaf("outside").threadRef)).toBeNull();
  expect(selectChatPaneRoot([root], null)).toBeNull();
});

describe("splitPane", () => {
  it("places the new leaf on the dropped side", () => {
    const root = splitPane(leaf("a"), "a", "left", leaf("b"), "s1");
    expect(root).toMatchObject({
      kind: "split",
      direction: "horizontal",
      first: { id: "b" },
      second: { id: "a" },
    });
    const bottom = splitPane(leaf("a"), "a", "bottom", leaf("b"), "s1");
    expect(bottom).toMatchObject({
      direction: "vertical",
      first: { id: "a" },
      second: { id: "b" },
    });
  });

  it("caps depth at a 2x2 grid and refuses same-axis nesting", () => {
    let root: ChatPaneNode = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(canSplitPane(root, "a", "horizontal")).toBe(false);
    expect(canSplitPane(root, "a", "vertical")).toBe(true);
    root = splitPane(root, "a", "bottom", leaf("c"), "s2");
    expect(canSplitPane(root, "c", "horizontal")).toBe(false);
    expect(canSplitPane(root, "c", "vertical")).toBe(false);
    expect(splitPane(root, "c", "right", leaf("d"), "s3")).toBe(root);
    expect(collectLeaves(root).map((item) => item.id)).toEqual(["a", "c", "b"]);
  });
});

describe("removePane", () => {
  it("collapses the sibling into the parent slot and empties the last leaf", () => {
    const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(removePane(root, "a")).toEqual(leaf("b"));
    expect(removePane(leaf("a"), "a")).toBeNull();
    expect(removePane(root, "missing")).toBe(root);
  });
});

describe("setPaneRatio", () => {
  it("clamps into the allowed range", () => {
    const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(setPaneRatio(root, "s1", 0.05)).toMatchObject({ ratio: 0.2 });
    expect(setPaneRatio(root, "s1", 2)).toMatchObject({ ratio: 0.8 });
    expect(setPaneRatio(root, "nope", 0.3)).toBe(root);
  });
});

describe("resolveDropZone", () => {
  it("prefers the long axis edges and falls back to the short axis in the middle", () => {
    expect(resolveDropZone(rect, 10, 50, allowAll)).toBe("left");
    expect(resolveDropZone(rect, 290, 50, allowAll)).toBe("right");
    expect(resolveDropZone(rect, 150, 10, allowAll)).toBe("top");
    expect(resolveDropZone(rect, 150, 90, allowAll)).toBe("bottom");
    const tall = { left: 0, top: 0, width: 100, height: 300 };
    expect(resolveDropZone(tall, 50, 10, allowAll)).toBe("top");
    expect(resolveDropZone(tall, 10, 150, allowAll)).toBe("left");
  });

  it("skips zones the tree refuses and ignores pointers outside the rect", () => {
    const onlyVertical = (zone: string) => zone === "top" || zone === "bottom";
    expect(resolveDropZone(rect, 10, 60, onlyVertical)).toBe("bottom");
    expect(resolveDropZone(rect, 150, 50, () => false)).toBeNull();
    expect(resolveDropZone(rect, -1, 50, allowAll)).toBeNull();
  });
});
