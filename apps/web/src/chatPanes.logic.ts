import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Pure helpers for the chat pane layout: a binary tree of splits whose leaves
 * each show one server thread. The tree stays shallow on purpose (a leaf can
 * split at most twice, and only across its parent's axis) so the result is
 * never deeper than a 2x2 grid. Anything beyond that stops being readable.
 */

export type ChatPaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type DropZone = "top" | "bottom" | "left" | "right";

export interface ChatPaneLeaf {
  readonly kind: "leaf";
  readonly id: ChatPaneId;
  readonly threadRef: ScopedThreadRef;
}

export interface ChatPaneSplit {
  readonly kind: "split";
  readonly id: ChatPaneId;
  readonly direction: SplitDirection;
  readonly first: ChatPaneNode;
  readonly second: ChatPaneNode;
  /** Share of the axis given to `first`, clamped to [MIN_RATIO, MAX_RATIO]. */
  readonly ratio: number;
}

export type ChatPaneNode = ChatPaneLeaf | ChatPaneSplit;

const MAX_PANE_DEPTH = 2;
const MIN_PANE_RATIO = 0.2;
const MAX_PANE_RATIO = 0.8;
const EDGE_REGION_FRACTION = 1 / 3;

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

export function collectLeaves(node: ChatPaneNode): ChatPaneLeaf[] {
  return node.kind === "leaf"
    ? [node]
    : [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function filterPaneTree(
  root: ChatPaneNode,
  include: (leaf: ChatPaneLeaf) => boolean,
): ChatPaneNode | null {
  return collectLeaves(root).reduce<ChatPaneNode | null>(
    (tree, leaf) => (tree && !include(leaf) ? removePane(tree, leaf.id) : tree),
    root,
  );
}

export function findLeafByThread(
  node: ChatPaneNode,
  threadRef: ScopedThreadRef,
): ChatPaneLeaf | null {
  return (
    collectLeaves(node).find(
      (leaf) =>
        leaf.threadRef.environmentId === threadRef.environmentId &&
        leaf.threadRef.threadId === threadRef.threadId,
    ) ?? null
  );
}

/** The group showing `threadRef`, or null when the thread renders on its own. */
export function selectChatPaneRoot(
  groups: ReadonlyArray<ChatPaneNode>,
  threadRef: ScopedThreadRef | null,
): ChatPaneNode | null {
  if (!threadRef) return null;
  return groups.find((group) => findLeafByThread(group, threadRef) !== null) ?? null;
}

function findPaneDepth(node: ChatPaneNode, paneId: ChatPaneId): number | null {
  if (node.id === paneId) return 0;
  if (node.kind === "leaf") return null;
  const first = findPaneDepth(node.first, paneId);
  if (first !== null) return first + 1;
  const second = findPaneDepth(node.second, paneId);
  return second === null ? null : second + 1;
}

function findParent(node: ChatPaneNode, paneId: ChatPaneId): ChatPaneSplit | null {
  if (node.kind === "leaf") return null;
  if (node.first.id === paneId || node.second.id === paneId) return node;
  return findParent(node.first, paneId) ?? findParent(node.second, paneId);
}

/** A leaf can split while it is above the depth cap and never along the same axis as its parent. */
export function canSplitPane(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  direction: SplitDirection,
): boolean {
  const depth = findPaneDepth(root, paneId);
  if (depth === null || depth >= MAX_PANE_DEPTH) return false;
  const parent = findParent(root, paneId);
  return parent === null || parent.direction !== direction;
}

export function zoneToSplit(zone: DropZone): {
  direction: SplitDirection;
  side: "first" | "second";
} {
  switch (zone) {
    case "left":
      return { direction: "horizontal", side: "first" };
    case "right":
      return { direction: "horizontal", side: "second" };
    case "top":
      return { direction: "vertical", side: "first" };
    case "bottom":
      return { direction: "vertical", side: "second" };
  }
}

export function splitPane(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  zone: DropZone,
  newLeaf: ChatPaneLeaf,
  splitId: ChatPaneId,
): ChatPaneNode {
  const { direction, side } = zoneToSplit(zone);
  if (!canSplitPane(root, paneId, direction)) return root;
  const replace = (node: ChatPaneNode): ChatPaneNode => {
    if (node.id === paneId) {
      return {
        kind: "split",
        id: splitId,
        direction,
        ratio: 0.5,
        first: side === "first" ? newLeaf : node,
        second: side === "first" ? node : newLeaf,
      };
    }
    if (node.kind === "leaf") return node;
    const first = replace(node.first);
    const second = replace(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return replace(root);
}

/** Removes a leaf. Its sibling takes the parent's slot; the last leaf leaves an empty layout. */
export function removePane(root: ChatPaneNode, paneId: ChatPaneId): ChatPaneNode | null {
  if (root.id === paneId) return null;
  if (root.kind === "leaf") return root;
  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

export function setPaneRatio(root: ChatPaneNode, splitId: ChatPaneId, ratio: number): ChatPaneNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId) return { ...root, ratio: clampPaneRatio(ratio) };
  const first = setPaneRatio(root.first, splitId, ratio);
  const second = setPaneRatio(root.second, splitId, ratio);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/**
 * Which edge the pointer is closest to, VS Code style: the outer third of the
 * long axis wins outright, the middle falls back to the short axis. Zones the
 * tree cannot honor are skipped so the preview never promises a split that
 * the drop would refuse.
 */
export function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  isZoneAllowed: (zone: DropZone) => boolean,
): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  const horizontal = relX < 0.5 ? (["left", "right"] as const) : (["right", "left"] as const);
  const vertical = relY < 0.5 ? (["top", "bottom"] as const) : (["bottom", "top"] as const);
  const pick = (candidates: readonly DropZone[]) => candidates.find(isZoneAllowed) ?? null;
  const wide = rect.width >= rect.height;
  const [longAxis, longRel, shortAxis] = wide
    ? [horizontal, relX, vertical]
    : [vertical, relY, horizontal];
  if (longRel < EDGE_REGION_FRACTION || longRel > 1 - EDGE_REGION_FRACTION) {
    const edge = pick([longAxis[0]]);
    if (edge) return edge;
  }
  return pick(shortAxis) ?? pick(longAxis);
}
