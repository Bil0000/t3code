import type { DesktopBridge, EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import {
  beginWindowCaptureAnimation,
  dismissWindowCaptureAnimation,
  finishAllWindowCaptureAnimations,
  finishWindowCaptureAnimation,
  getPendingWindowCaptureAnimations,
  pendingWindowCaptureAnimationIdsForTarget,
  pendingWindowCaptureAnimationSource,
  scheduleWindowCaptureAnimationDestination,
  updateWindowCaptureAnimationSource,
} from "./windowCaptureAnimation";

describe("window capture animation", () => {
  beforeEach(() => finishAllWindowCaptureAnimations());

  it("reserves and releases a composer attachment slot", () => {
    const target = "draft-1" as DraftId;

    beginWindowCaptureAnimation("capture-1", target);
    expect(
      pendingWindowCaptureAnimationIdsForTarget(getPendingWindowCaptureAnimations(), target),
    ).toEqual(["capture-1"]);

    finishWindowCaptureAnimation("capture-1");
    expect(getPendingWindowCaptureAnimations()).toEqual([]);
  });

  it("keeps reservations scoped to their thread", () => {
    const first = {
      environmentId: "environment-1" as EnvironmentId,
      threadId: "thread-1" as ThreadId,
    } satisfies ScopedThreadRef;
    const second = {
      environmentId: "environment-1" as EnvironmentId,
      threadId: "thread-2" as ThreadId,
    } satisfies ScopedThreadRef;

    beginWindowCaptureAnimation("capture-1", first);

    expect(
      pendingWindowCaptureAnimationIdsForTarget(getPendingWindowCaptureAnimations(), first),
    ).toEqual(["capture-1"]);
    expect(
      pendingWindowCaptureAnimationIdsForTarget(getPendingWindowCaptureAnimations(), second),
    ).toEqual([]);
  });

  it("survives the setup and cleanup replay used by React Strict Mode", async () => {
    const target = "draft-1" as DraftId;
    const startAnimation = vi.fn();
    const disconnectAnimation = vi.fn();
    beginWindowCaptureAnimation("capture-1", target);

    const stopFirstSetup = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      startAnimation,
      undefined,
      disconnectAnimation,
    );
    stopFirstSetup();
    const stopSecondSetup = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      startAnimation,
      undefined,
      disconnectAnimation,
    );
    await Promise.resolve();

    expect(startAnimation).toHaveBeenCalledTimes(1);
    expect(disconnectAnimation).not.toHaveBeenCalled();

    stopSecondSetup();
    const stopThirdSetup = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      startAnimation,
      undefined,
      disconnectAnimation,
    );
    await Promise.resolve();
    expect(startAnimation).toHaveBeenCalledTimes(1);
    expect(disconnectAnimation).not.toHaveBeenCalled();
    finishWindowCaptureAnimation("capture-1");
    stopThirdSetup();
  });

  it("disconnects the native card when its composer destination unmounts", async () => {
    const target = "draft-1" as DraftId;
    const disconnectAnimation = vi.fn();
    beginWindowCaptureAnimation("capture-1", target);

    const stop = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      vi.fn(),
      undefined,
      disconnectAnimation,
    );
    await Promise.resolve();
    stop();
    await Promise.resolve();

    expect(disconnectAnimation).toHaveBeenCalledTimes(1);
  });

  it("hides the native card without acknowledging its capture files", () => {
    const target = "draft-1" as DraftId;
    const dismiss = vi.fn(() => Promise.resolve());
    const bridge = {
      getWindowCaptureState: vi.fn(),
      checkWindowCaptureShortcut: vi.fn(),
      setWindowCaptureShortcutSuppressed: vi.fn(),
      captureWindow: vi.fn(),
      listPendingWindowCaptures: vi.fn(),
      readWindowCapture: vi.fn(),
      dismissWindowCaptureAnimation: dismiss,
      acknowledgeWindowCapture: vi.fn(),
    } as unknown as DesktopBridge;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: bridge },
    });

    try {
      beginWindowCaptureAnimation("capture-1", target);
      dismissWindowCaptureAnimation("capture-1");

      expect(getPendingWindowCaptureAnimations()).toEqual([]);
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalledWith("capture-1");
      expect(bridge.acknowledgeWindowCapture).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("keeps the native card through the placeholder-to-attachment handoff", async () => {
    const target = "draft-1" as DraftId;
    const disconnectAnimation = vi.fn();
    beginWindowCaptureAnimation("capture-1", target);

    const stopPlaceholder = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      vi.fn(),
      undefined,
      disconnectAnimation,
    );
    await Promise.resolve();
    stopPlaceholder();
    const stopAttachment = scheduleWindowCaptureAnimationDestination(
      "capture-1",
      vi.fn(),
      undefined,
      disconnectAnimation,
    );
    await Promise.resolve();

    expect(disconnectAnimation).not.toHaveBeenCalled();
    finishWindowCaptureAnimation("capture-1");
    stopAttachment();
  });

  it("updates details after the placeholder has already started the flight", async () => {
    const startAnimation = vi.fn();
    const updateDetails = vi.fn();

    scheduleWindowCaptureAnimationDestination("capture-1", startAnimation);
    await Promise.resolve();
    scheduleWindowCaptureAnimationDestination("capture-1", startAnimation, updateDetails);
    await Promise.resolve();

    expect(startAnimation).toHaveBeenCalledTimes(1);
    expect(updateDetails).toHaveBeenCalledTimes(1);
  });

  it("adds lightweight capture details without committing the image", () => {
    const target = "draft-1" as DraftId;
    const source = {
      kind: "window-capture" as const,
      capturedAt: "2026-08-29T00:00:00.000Z",
      appName: "T3 Code",
      windowTitle: "Capture animation",
    };

    beginWindowCaptureAnimation("capture-1", target);
    updateWindowCaptureAnimationSource("capture-1", source);

    expect(
      pendingWindowCaptureAnimationSource(getPendingWindowCaptureAnimations(), "capture-1"),
    ).toEqual(source);
    expect(getPendingWindowCaptureAnimations()).toHaveLength(1);
  });
});
