import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { ChatPaneId, DropZone } from "./chatPanes.logic";

export interface ChatPaneDropTarget {
  readonly paneId: ChatPaneId;
  readonly zone: DropZone;
}

/**
 * A thread being carried over the chat area. The sidebar's dnd-kit gesture
 * and a pane header's pointer drag both publish here, so the pane drop
 * overlays have one source to read and never care where the drag began. The
 * gesture owner reads `target` on release and applies the drop itself.
 */
interface ChatPaneDragState {
  threadRef: ScopedThreadRef | null;
  title: string;
  /** Pane the thread came from, when rearranging an open pane. */
  sourcePaneId: ChatPaneId | null;
  target: ChatPaneDropTarget | null;
  start: (input: { threadRef: ScopedThreadRef; title: string; sourcePaneId?: ChatPaneId }) => void;
  setTarget: (paneId: ChatPaneId, zone: DropZone | null) => void;
  end: () => void;
}

export const useChatPaneDragStore = create<ChatPaneDragState>((set, get) => ({
  threadRef: null,
  title: "",
  sourcePaneId: null,
  target: null,
  start: ({ threadRef, title, sourcePaneId }) =>
    set({ threadRef, title, sourcePaneId: sourcePaneId ?? null, target: null }),
  setTarget: (paneId, zone) =>
    set((state) => {
      if (state.threadRef === null) return state;
      if (zone === null) {
        return state.target?.paneId === paneId ? { target: null } : state;
      }
      return state.target?.paneId === paneId && state.target.zone === zone
        ? state
        : { target: { paneId, zone } };
    }),
  end: () => {
    if (get().threadRef !== null) {
      set({ threadRef: null, title: "", sourcePaneId: null, target: null });
    }
  },
}));

export function isChatPaneDragActive(): boolean {
  return useChatPaneDragStore.getState().threadRef !== null;
}
