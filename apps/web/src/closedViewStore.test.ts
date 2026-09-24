import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
});

describe("closedViewStore", () => {
  it("keeps a newest-first history across environments and removes only the restored entry", () => {
    const store = useClosedViewStore.getState();
    const id = store.remember({
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "diff", id: "diff" },
    });
    store.remember({ kind: "panel-tab", threadRef: refB, surface: { kind: "diff", id: "diff" } });

    const [latest, earlier] = useClosedViewStore.getState().entries;
    expect(latest).toMatchObject({ kind: "panel-tab", threadRef: refB, surface: { id: "diff" } });
    expect(earlier).toMatchObject({ kind: "panel-tab", threadRef: refA });
    expect(latest?.id).not.toBe(earlier?.id);
    expect(earlier?.id).toBe(id);

    store.remove(latest!.id);
    expect(useClosedViewStore.getState().entries).toEqual([earlier]);
  });

  it("moves a closed target to the front without duplicate entries and retains device tab data", () => {
    const store = useClosedViewStore.getState();
    const device = {
      kind: "panel-tab",
      threadRef: refA,
      surface: {
        kind: "device",
        id: "device:nucbox:emulator-5580",
        target: { hostId: "nucbox", deviceId: "emulator-5580", platform: "android", name: "Pixel" },
        title: "Custom",
      },
    } as const;
    store.remember(device);
    store.remember({ kind: "panel-tab", threadRef: refB, surface: { kind: "diff", id: "diff" } });
    store.remember(device);

    expect(useClosedViewStore.getState().entries).toMatchObject([
      { ...device },
      { kind: "panel-tab", threadRef: refB, surface: { id: "diff" } },
    ]);
    expect(useClosedViewStore.getState().entries).toHaveLength(2);
  });

  it("caps the shared history at 20", () => {
    const store = useClosedViewStore.getState();
    for (let index = 0; index < 24; index++) {
      store.remember({
        kind: "panel-tab",
        threadRef: refA,
        surface: {
          kind: "file",
          id: `file:src/${index}.ts`,
          relativePath: `src/${index}.ts`,
          revealLine: null,
          revealRequestId: 0,
        },
      });
    }
    expect(useClosedViewStore.getState().entries).toHaveLength(20);
    expect(useClosedViewStore.getState().entries[0]).toMatchObject({
      surface: { id: "file:src/23.ts" },
    });
    expect(useClosedViewStore.getState().entries.at(-1)).toMatchObject({
      surface: { id: "file:src/4.ts" },
    });
  });
});
