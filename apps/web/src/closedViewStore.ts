import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type PreviewSessionSnapshot, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import { type RightPanelSurface } from "./rightPanelStore";

export type ClosedView =
  | { kind: "panel-tab"; threadRef: ScopedThreadRef; surface: RightPanelSurface }
  | { kind: "panel"; threadRef: ScopedThreadRef }
  | { kind: "browser"; threadRef: ScopedThreadRef; snapshot: PreviewSessionSnapshot }
  | {
      kind: "terminal";
      threadRef: ScopedThreadRef;
      terminalId: string;
      panelSurfaceId?: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { kind: "terminal-drawer"; threadRef: ScopedThreadRef };

export type ClosedViewEntry = ClosedView & { id: string };

interface ClosedViewStoreState {
  entries: ClosedViewEntry[];
  remember: (view: ClosedView) => string;
  remove: (id: string) => void;
}

const sameTarget = (entry: ClosedViewEntry, view: ClosedView): boolean => {
  if (
    entry.kind !== view.kind ||
    scopedThreadKey(entry.threadRef) !== scopedThreadKey(view.threadRef)
  ) {
    return false;
  }
  switch (entry.kind) {
    case "panel-tab":
      return view.kind === "panel-tab" && entry.surface.id === view.surface.id;
    case "browser":
      return view.kind === "browser" && entry.snapshot.tabId === view.snapshot.tabId;
    case "terminal":
      return view.kind === "terminal" && entry.terminalId === view.terminalId;
    case "panel":
    case "terminal-drawer":
      return true;
  }
};

export const useClosedViewStore = create<ClosedViewStoreState>()(
  persist(
    (set) => ({
      entries: [],
      remember: (view) => {
        const id = randomUUID();
        set((state) => ({
          entries: [
            { ...view, id },
            ...state.entries.filter((entry) => !sameTarget(entry, view)),
          ].slice(0, 20),
        }));
        return id;
      },
      remove: (id) =>
        set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
    }),
    {
      name: "t3code:closed-views:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ entries }) => ({ entries }),
    },
  ),
);
