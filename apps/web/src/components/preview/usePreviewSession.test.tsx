import { act } from "react";
import { create } from "react-test-renderer";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { PreviewListResult, ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { usePreviewSession } from "./usePreviewSession";

vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: () => sessionsAtom, events: () => eventsAtom },
}));
const ref = { environmentId: "local", threadId: "design-thread" } as ScopedThreadRef;
const saved: PreviewListResult = {
  serverEpoch: "server",
  revision: 1,
  sessions: [
    {
      threadId: ref.threadId,
      tabId: "design-tab",
      navStatus: {
        _tag: "Loading",
        title: "Design",
        url: "http://localhost/api/assets/design?t3-design=1&t3-design-path=.t3/designs/thread.html",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-09-15T00:00:00Z",
    },
  ],
};
const sessionsAtom = Atom.make(AsyncResult.success(saved));
const eventsAtom = Atom.make(AsyncResult.initial());
function Host() {
  usePreviewSession(ref);
  return null;
}

afterEach(() => {
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});
it("restores existing designs before any preview surface is mounted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <Host />
        </AppAtomRegistryProvider>,
      );
    });
    expect(readThreadPreviewState(ref).sessions["design-tab"]).toEqual(saved.sessions[0]);
  } finally {
    await act(() => renderer?.unmount());
  }
});
