import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import {
  beginWindowCaptureAnimation,
  dismissAllWindowCaptureAnimations,
  finishWindowCaptureAnimation,
  getPendingWindowCaptureAnimations,
  pendingWindowCaptureAnimationIdsForTarget,
  scheduleWindowCaptureAnimationDestination,
  updateWindowCaptureAnimationSource,
} from "./windowCaptureAnimation";

describe("window capture animation", () => {
  beforeEach(() => dismissAllWindowCaptureAnimations());

  it("keeps each reserved composer slot with its target and source", () => {
    const draft = "draft-1" as DraftId;
    const thread = {
      environmentId: "environment-1" as EnvironmentId,
      threadId: "thread-1" as ThreadId,
    } satisfies ScopedThreadRef;
    const source = {
      kind: "window-capture" as const,
      capturedAt: "2026-08-29T00:00:00.000Z",
      appName: "T3 Code",
      windowTitle: "Capture animation",
    };

    beginWindowCaptureAnimation("capture-1", draft);
    updateWindowCaptureAnimationSource("capture-1", source);

    const pending = getPendingWindowCaptureAnimations();
    expect(pending[0]).toMatchObject({ target: draft });
    expect(pendingWindowCaptureAnimationIdsForTarget(pending, draft)).toEqual(["capture-1"]);
    expect(pendingWindowCaptureAnimationIdsForTarget(pending, thread)).toEqual([]);
    expect(pending[0]?.source).toEqual(source);
  });

  it("keeps one card through Strict Mode and the attachment handoff", async () => {
    const start = vi.fn();
    beginWindowCaptureAnimation("capture-1", "draft-1" as DraftId);

    const stopFirstSetup = scheduleWindowCaptureAnimationDestination("capture-1", start);
    stopFirstSetup();
    const stopPlaceholder = scheduleWindowCaptureAnimationDestination("capture-1", start);
    await Promise.resolve();
    stopPlaceholder();
    const stopAttachment = scheduleWindowCaptureAnimationDestination("capture-1", start);
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(2);
    expect(getPendingWindowCaptureAnimations()).toHaveLength(1);
    finishWindowCaptureAnimation("capture-1");
    stopAttachment();
  });
});
