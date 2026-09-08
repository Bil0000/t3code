import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useChatPaneDragStore } from "./chatPaneDragStore";
import {
  canSplitPane,
  clampPaneRatio,
  collectLeaves,
  findLeafByThread,
  removePane,
  resolveDropZone,
  selectChatPaneRoot,
  setPaneRatio,
  splitPane,
  zoneToSplit,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type DropZone,
} from "./chatPanes.logic";
import { randomUUID } from "./lib/utils";
import { resolveStorage } from "./lib/storage";

/**
 * The split layouts of one browser window. Each group is a tree of splits; a
 * thread belongs to at most one group. The route stays the source of truth
 * for the focused thread; this store only remembers which other threads sit
 * beside it and how the space is divided. A group that collapses to one pane
 * is the plain chat view, so it is dropped as soon as that happens.
 */

const LeafSchema = Schema.Struct({
  kind: Schema.Literal("leaf"),
  id: Schema.String,
  threadRef: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
});
const NodeSchema: Schema.Codec<ChatPaneNode> = Schema.Union([
  LeafSchema,
  Schema.Struct({
    kind: Schema.Literal("split"),
    id: Schema.String,
    direction: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Finite.check(Schema.makeFilter((ratio) => ratio === clampPaneRatio(ratio))),
    first: Schema.suspend(() => NodeSchema),
    second: Schema.suspend(() => NodeSchema),
  }),
]) as Schema.Codec<ChatPaneNode>;
const PersistedSchema = Schema.Struct({
  groups: Schema.Array(NodeSchema),
  focusedPaneId: Schema.NullOr(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

interface ChatPanesState {
  groups: ReadonlyArray<ChatPaneNode>;
  focusedPaneId: ChatPaneId | null;
  focusPane: (paneId: ChatPaneId) => void;
  /** Splits `paneId` and shows `threadRef` on the dropped side. */
  dropThread: (paneId: ChatPaneId, zone: DropZone, threadRef: ScopedThreadRef) => void;
  /** Starts a new group from a thread shown on its own. */
  splitFromThread: (anchorRef: ScopedThreadRef, zone: DropZone, threadRef: ScopedThreadRef) => void;
  /** Moves an open pane's thread next to another pane, in any group. */
  movePane: (paneId: ChatPaneId, targetPaneId: ChatPaneId, zone: DropZone) => void;
  /**
   * Removes a leaf. Returns the thread the route should move to when the
   * focused pane closed, so the caller can navigate before the layout
   * collapses, or null when the route is unaffected.
   */
  closePane: (paneId: ChatPaneId) => ScopedThreadRef | null;
  closeThread: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
}

function sameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function findPane(groups: ReadonlyArray<ChatPaneNode>, paneId: ChatPaneId) {
  for (const group of groups) {
    const leaf = collectLeaves(group).find((item) => item.id === paneId);
    if (leaf) return { group, leaf };
  }
  return null;
}

/** Swaps one group for its replacement and drops every group down to one
    pane: `to` after a close, and the source movePane already shrank. */
function replaceGroup(groups: ReadonlyArray<ChatPaneNode>, from: ChatPaneNode, to: ChatPaneNode) {
  return groups
    .map((group) => (group === from ? to : group))
    .filter((group) => group.kind === "split");
}

function closeLeaf(
  set: (partial: Partial<ChatPanesState>) => void,
  state: Pick<ChatPanesState, "groups" | "focusedPaneId">,
  paneId: ChatPaneId,
): ScopedThreadRef | null {
  const group = findPane(state.groups, paneId)?.group;
  const root = group ? removePane(group, paneId) : null;
  if (!group || !root) return null;
  const survivor = collectLeaves(root)[0]!;
  const focusedClosed = state.focusedPaneId === paneId;
  set({
    groups: replaceGroup(state.groups, group, root),
    focusedPaneId: focusedClosed ? survivor.id : state.focusedPaneId,
  });
  return focusedClosed ? survivor.threadRef : null;
}

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set, get) => ({
      groups: [],
      focusedPaneId: null,
      focusPane: (paneId) =>
        set((state) => (state.focusedPaneId === paneId ? state : { focusedPaneId: paneId })),
      dropThread: (paneId, zone, threadRef) =>
        set((state) => {
          const group = findPane(state.groups, paneId)?.group;
          if (!group || selectChatPaneRoot(state.groups, threadRef)) return state;
          const leaf: ChatPaneLeaf = { kind: "leaf", id: randomUUID(), threadRef };
          const root = splitPane(group, paneId, zone, leaf, randomUUID());
          if (root === group) return state;
          return { groups: replaceGroup(state.groups, group, root), focusedPaneId: leaf.id };
        }),
      splitFromThread: (anchorRef, zone, threadRef) =>
        set((state) => {
          if (
            sameThread(anchorRef, threadRef) ||
            selectChatPaneRoot(state.groups, anchorRef) ||
            selectChatPaneRoot(state.groups, threadRef)
          ) {
            return state;
          }
          const anchor: ChatPaneLeaf = { kind: "leaf", id: randomUUID(), threadRef: anchorRef };
          const leaf: ChatPaneLeaf = { kind: "leaf", id: randomUUID(), threadRef };
          const root = splitPane(anchor, anchor.id, zone, leaf, randomUUID());
          return { groups: [...state.groups, root], focusedPaneId: leaf.id };
        }),
      movePane: (paneId, targetPaneId, zone) =>
        set((state) => {
          if (paneId === targetPaneId) return state;
          const found = findPane(state.groups, paneId);
          if (!found) return state;
          const { group: source, leaf } = found;
          const without = removePane(source, paneId)!;
          const groups = state.groups.map((group) => (group === source ? without : group));
          const target = findPane(groups, targetPaneId)?.group;
          if (!target) return state;
          const root = splitPane(target, targetPaneId, zone, leaf, randomUUID());
          if (root === target) return state;
          return { groups: replaceGroup(groups, target, root), focusedPaneId: leaf.id };
        }),
      closePane: (paneId) => closeLeaf(set, get(), paneId),
      closeThread: (threadRef) => {
        const state = get();
        const group = selectChatPaneRoot(state.groups, threadRef);
        const leaf = group ? findLeafByThread(group, threadRef) : null;
        return leaf ? closeLeaf(set, state, leaf.id) : null;
      },
      setRatio: (splitId, ratio) =>
        set((state) => {
          const groups = state.groups.map((group) => setPaneRatio(group, splitId, ratio));
          return groups.every((group, index) => group === state.groups[index]) ? state : { groups };
        }),
    }),
    {
      name: "t3code:chat-panes:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ groups: state.groups, focusedPaneId: state.focusedPaneId }),
      merge: (persisted, current) => {
        try {
          const { groups, focusedPaneId } = decodePersisted(persisted);
          return {
            ...current,
            groups: groups.filter((group) => group.kind === "split"),
            focusedPaneId,
          };
        } catch {
          return current;
        }
      },
    },
  ),
);

export function selectPaneDropZoneResolver(root: ChatPaneNode | null, paneId: ChatPaneId) {
  return (
    rect: { left: number; top: number; width: number; height: number },
    clientX: number,
    clientY: number,
  ): DropZone | null =>
    resolveDropZone(
      rect,
      clientX,
      clientY,
      (zone) => root === null || canSplitPane(root, paneId, zoneToSplit(zone).direction),
    );
}

/**
 * Applies the drop the drag store is pointing at. A drop on the plain chat
 * view starts a new group from the route thread. Returns the thread that
 * should become the route so the caller can navigate to it.
 */
export function commitChatPaneDrop(routeThreadRef: ScopedThreadRef): ScopedThreadRef | null {
  const drag = useChatPaneDragStore.getState();
  const { threadRef, target, sourcePaneId } = drag;
  drag.end();
  if (!threadRef || !target) return null;
  const store = useChatPanesStore.getState();
  const before = store.groups;
  if (sourcePaneId !== null) {
    store.movePane(sourcePaneId, target.paneId, target.zone);
  } else {
    // No pane matched the target: the drop landed on a thread shown alone.
    store.dropThread(target.paneId, target.zone, threadRef);
    if (useChatPanesStore.getState().groups === before) {
      store.splitFromThread(routeThreadRef, target.zone, threadRef);
    }
  }
  return useChatPanesStore.getState().groups === before ? null : threadRef;
}

/** The zone a menu-driven split lands on: beside the focused pane, or below it once the row is full. */
function splitZoneForFocusedPane(
  group: ChatPaneNode,
  focusedPaneId: ChatPaneId | null,
): { anchor: ChatPaneLeaf; zone: DropZone } | null {
  const leaves = collectLeaves(group);
  const anchor = leaves.find((leaf) => leaf.id === focusedPaneId) ?? leaves[0]!;
  if (canSplitPane(group, anchor.id, "horizontal")) return { anchor, zone: "right" };
  if (canSplitPane(group, anchor.id, "vertical")) return { anchor, zone: "bottom" };
  return null;
}

/** Whether "Open in split view" can place `threadRef` beside the route thread right now. */
export function canOpenThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (!routeThreadRef || sameThread(routeThreadRef, threadRef)) return false;
  const state = useChatPanesStore.getState();
  if (selectChatPaneRoot(state.groups, threadRef)) return false;
  const group = selectChatPaneRoot(state.groups, routeThreadRef);
  return group === null || splitZoneForFocusedPane(group, state.focusedPaneId) !== null;
}

/** Opens `threadRef` beside the focused pane, starting a new group from the route thread when needed. */
export function openThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (!canOpenThreadInSplit(routeThreadRef, threadRef)) return false;
  const state = useChatPanesStore.getState();
  const group = selectChatPaneRoot(state.groups, routeThreadRef);
  if (group) {
    const placement = splitZoneForFocusedPane(group, state.focusedPaneId);
    if (!placement) return false;
    state.dropThread(placement.anchor.id, placement.zone, threadRef);
  } else {
    state.splitFromThread(routeThreadRef!, "right", threadRef);
  }
  return useChatPanesStore.getState().groups !== state.groups;
}
