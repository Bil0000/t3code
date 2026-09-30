import { EnvironmentId, ThreadId, type PreviewListResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ listCalls: 0, list: null as PreviewListResult | null }));

vi.mock("~/state/preview", () => {
  const list = Atom.make(() => {
    mocks.listCalls += 1;
    return mocks.list ? AsyncResult.success(mocks.list) : AsyncResult.initial(true);
  }).pipe(Atom.swr({ staleTime: 5_000, revalidateOnMount: true }));
  const events = Atom.make(AsyncResult.initial(true));
  return { previewEnvironment: { list: () => list, events: () => events } };
});

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";

import { usePreviewSession } from "./usePreviewSession";

const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") };
let renderer: ReactTestRenderer | undefined;

function Probe() {
  usePreviewSession(threadRef);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetPreviewStateForTests();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("usePreviewSession", () => {
  it("loads the server's preview list on mount and restores its tabs", async () => {
    mocks.list = {
      serverEpoch: "epoch-1",
      revision: 1,
      sessions: [
        {
          threadId: threadRef.threadId,
          tabId: "tab-1",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-09-30T12:00:00.000Z",
        },
      ],
    };

    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <Probe />
        </AppAtomRegistryProvider>,
      );
    });

    expect(mocks.listCalls).toBeGreaterThan(0);
    const state = readThreadPreviewState(threadRef);
    expect(state.serverEpoch).toBe("epoch-1");
    expect(Object.keys(state.sessions)).toEqual(["tab-1"]);
  });
});
