import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useChatPaneDragStore } from "./chatPaneDragStore";
import {
  canSplitPane,
  collectLeaves,
  findLeafByThread,
  removePane,
  resolveDropZone,
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
 * One split layout per browser window. The route stays the source of truth
 * for the focused thread; this store only remembers which other threads sit
 * beside it and how the space is divided. A single-leaf layout is the plain
 * chat view, so the layout is dropped as soon as it collapses to one pane.
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
    ratio: Schema.Number,
    first: Schema.suspend(() => NodeSchema),
    second: Schema.suspend(() => NodeSchema),
  }),
]) as Schema.Codec<ChatPaneNode>;
const PersistedSchema = Schema.Struct({
  root: Schema.NullOr(NodeSchema),
  focusedPaneId: Schema.NullOr(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

interface ChatPanesState {
  root: ChatPaneNode | null;
  /** Leaf that last held the route thread; the pane a plain navigation reuses. */
  focusedPaneId: ChatPaneId | null;
  focusPane: (paneId: ChatPaneId) => void;
  /** Splits `paneId` and shows `threadRef` on the dropped side. */
  dropThread: (paneId: ChatPaneId, zone: DropZone, threadRef: ScopedThreadRef) => void;
  /** Moves an open pane's thread next to another pane. */
  movePane: (paneId: ChatPaneId, targetPaneId: ChatPaneId, zone: DropZone) => void;
  /** Shows `threadRef` in the focused pane, so a plain navigation keeps the layout. */
  showThread: (threadRef: ScopedThreadRef) => void;
  /**
   * Removes a leaf. Returns the thread the route should move to when the
   * focused pane closed, so the caller can navigate before the layout
   * collapses, or null when the route is unaffected.
   */
  closePane: (paneId: ChatPaneId) => ScopedThreadRef | null;
  closeThread: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
}

function normalizeRoot(root: ChatPaneNode | null): ChatPaneNode | null {
  return root?.kind === "split" ? root : null;
}

function closeLeaf(
  set: (partial: Partial<ChatPanesState>) => void,
  state: Pick<ChatPanesState, "root" | "focusedPaneId">,
  paneId: ChatPaneId,
): ScopedThreadRef | null {
  if (!state.root) return null;
  const root = removePane(state.root, paneId);
  if (root === state.root || root === null) return null;
  const survivor = collectLeaves(root)[0]!;
  const focusedClosed = state.focusedPaneId === paneId;
  set({
    root: normalizeRoot(root),
    focusedPaneId: focusedClosed ? survivor.id : state.focusedPaneId,
  });
  return focusedClosed ? survivor.threadRef : null;
}

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set, get) => ({
      root: null,
      focusedPaneId: null,
      focusPane: (paneId) =>
        set((state) => (state.focusedPaneId === paneId ? state : { focusedPaneId: paneId })),
      dropThread: (paneId, zone, threadRef) =>
        set((state) => {
          if (!state.root || findLeafByThread(state.root, threadRef)) return state;
          const leaf: ChatPaneLeaf = { kind: "leaf", id: randomUUID(), threadRef };
          const root = splitPane(state.root, paneId, zone, leaf, randomUUID());
          return root === state.root ? state : { root, focusedPaneId: leaf.id };
        }),
      movePane: (paneId, targetPaneId, zone) =>
        set((state) => {
          if (!state.root || paneId === targetPaneId) return state;
          const leaf = collectLeaves(state.root).find((item) => item.id === paneId);
          const without = leaf ? removePane(state.root, paneId) : null;
          if (!leaf || !without) return state;
          const root = splitPane(without, targetPaneId, zone, leaf, randomUUID());
          return root === without ? state : { root, focusedPaneId: leaf.id };
        }),
      showThread: (threadRef) =>
        set((state) => {
          if (!state.root || findLeafByThread(state.root, threadRef)) return state;
          const leaves = collectLeaves(state.root);
          const target = leaves.find((leaf) => leaf.id === state.focusedPaneId) ?? leaves[0];
          if (!target) return state;
          const swap = (node: ChatPaneNode): ChatPaneNode =>
            node.kind === "leaf"
              ? node.id === target.id
                ? { ...node, threadRef }
                : node
              : { ...node, first: swap(node.first), second: swap(node.second) };
          return { root: swap(state.root), focusedPaneId: target.id };
        }),
      closePane: (paneId) => closeLeaf(set, get(), paneId),
      closeThread: (threadRef) => {
        const state = get();
        const leaf = state.root ? findLeafByThread(state.root, threadRef) : null;
        return leaf ? closeLeaf(set, state, leaf.id) : null;
      },
      setRatio: (splitId, ratio) =>
        set((state) => {
          if (!state.root) return state;
          const root = setPaneRatio(state.root, splitId, ratio);
          return root === state.root ? state : { root };
        }),
    }),
    {
      name: "t3code:chat-panes:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ root: state.root, focusedPaneId: state.focusedPaneId }),
      merge: (persisted, current) => {
        try {
          const { root, focusedPaneId } = decodePersisted(persisted);
          return { ...current, root: normalizeRoot(root), focusedPaneId };
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
 * view seeds the layout from the route thread first. Returns the thread that
 * should become the route so the caller can navigate to it.
 */
export function commitChatPaneDrop(routeThreadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  const drag = useChatPaneDragStore.getState();
  const { threadRef, target, sourcePaneId } = drag;
  drag.end();
  if (!threadRef || !target) return null;
  if (sourcePaneId !== null) {
    const before = useChatPanesStore.getState().root;
    useChatPanesStore.getState().movePane(sourcePaneId, target.paneId, target.zone);
    return useChatPanesStore.getState().root === before ? null : threadRef;
  }
  if (!seedLayout(routeThreadRef, threadRef, target.paneId)) return null;
  useChatPanesStore.getState().dropThread(target.paneId, target.zone, threadRef);
  return useChatPanesStore.getState().root === null ? null : threadRef;
}

/** The plain chat view has no layout yet; make the route thread its first leaf. */
function seedLayout(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
  paneId: ChatPaneId,
): boolean {
  if (useChatPanesStore.getState().root !== null) return true;
  if (
    !routeThreadRef ||
    (routeThreadRef.environmentId === threadRef.environmentId &&
      routeThreadRef.threadId === threadRef.threadId)
  ) {
    return false;
  }
  useChatPanesStore.setState({
    root: { kind: "leaf", id: paneId, threadRef: routeThreadRef },
    focusedPaneId: paneId,
  });
  return true;
}

/** The zone a menu-driven split lands on: beside the focused pane, or below it once the row is full. */
function splitZoneForFocusedPane(state: ChatPanesState): {
  anchor: ChatPaneLeaf;
  zone: DropZone;
} | null {
  if (!state.root) return null;
  const leaves = collectLeaves(state.root);
  const anchor = leaves.find((leaf) => leaf.id === state.focusedPaneId) ?? leaves[0];
  if (!anchor) return null;
  if (canSplitPane(state.root, anchor.id, "horizontal")) return { anchor, zone: "right" };
  if (canSplitPane(state.root, anchor.id, "vertical")) return { anchor, zone: "bottom" };
  return null;
}

/** Whether "Open in split view" can place `threadRef` beside the route thread right now. */
export function canOpenThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (
    !routeThreadRef ||
    (routeThreadRef.environmentId === threadRef.environmentId &&
      routeThreadRef.threadId === threadRef.threadId)
  ) {
    return false;
  }
  const state = useChatPanesStore.getState();
  if (state.root === null) return true;
  return (
    findLeafByThread(state.root, threadRef) === null && splitZoneForFocusedPane(state) !== null
  );
}

/** Opens `threadRef` beside the focused pane, seeding a layout from the route thread when needed. */
export function openThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (!canOpenThreadInSplit(routeThreadRef, threadRef)) return false;
  if (!seedLayout(routeThreadRef, threadRef, randomUUID())) return false;
  const current = useChatPanesStore.getState();
  const placement = splitZoneForFocusedPane(current);
  if (!placement) return false;
  current.dropThread(placement.anchor.id, placement.zone, threadRef);
  return useChatPanesStore.getState().root !== current.root;
}
