import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DesktopPendingWindowCapture,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { DesktopWindowCaptureBridge } from "../../lib/desktopWindowCapture";
import {
  beginWindowCaptureAnimationWhenReady,
  deliverWindowCapture,
  dismissFailedWindowCapture,
  resolveExistingWindowCaptureTarget,
  resolveWindowCaptureTargetOnce,
} from "./WindowCaptureCoordinator";
import {
  beginWindowCaptureAnimation,
  dismissAllWindowCaptureAnimations,
  getPendingWindowCaptureAnimations,
  setWindowCaptureAnimationDestination,
} from "../../lib/windowCaptureAnimation";

const environmentId = EnvironmentId.make("window-capture-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("window-capture-project"));

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

afterEach(() => {
  dismissAllWindowCaptureAnimations();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window capture failures", () => {
  it("dismisses an older failed capture without disturbing a newer capture", async () => {
    const target = DraftId.make("window-capture-draft");
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const dismissWindowCaptureAnimation = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        requestWindowCapturePermissions: vi.fn(),
        getWindowCaptureState: vi.fn(),
        checkWindowCaptureShortcut: vi.fn(),
        setWindowCaptureShortcutSuppressed: vi.fn(),
        captureWindow: vi.fn(),
        listPendingWindowCaptures: vi.fn(),
        readWindowCapture: vi.fn(),
        acknowledgeWindowCapture: vi.fn(),
        dismissWindowCaptureAnimation,
      },
    });
    await beginWindowCaptureAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    await beginWindowCaptureAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedWindowCapture("older", soundedIds, pendingStarts);

    expect(getPendingWindowCaptureAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(dismissWindowCaptureAnimation).toHaveBeenCalledExactlyOnceWith("older");
  });

  it("does not resurrect a failed capture when its draft becomes ready later", async () => {
    const target = DraftId.make("window-capture-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const olderStart = beginWindowCaptureAnimationWhenReady("older", targetReady, pendingStarts);
    await beginWindowCaptureAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedWindowCapture("older", soundedIds, pendingStarts);
    resolveTarget?.(target);
    await olderStart;

    expect(getPendingWindowCaptureAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(pendingStarts.size).toBe(0);
  });

  it("keeps global failures dismissing all active and pending captures", async () => {
    const target = DraftId.make("window-capture-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    await beginWindowCaptureAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    const newerStart = beginWindowCaptureAnimationWhenReady("newer", targetReady, pendingStarts);

    dismissFailedWindowCapture(undefined, soundedIds, pendingStarts);
    resolveTarget?.(target);
    await newerStart;

    expect(getPendingWindowCaptureAnimations()).toEqual([]);
    expect(soundedIds.size).toBe(0);
    expect(pendingStarts.size).toBe(0);
  });
});

describe("window capture delivery", () => {
  it.each([
    { target: DraftId.make("window-capture-draft"), accessibleText: undefined },
    { target: DraftId.make("window-capture-draft"), accessibleText: "const answer = 42;" },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("window-capture-thread")),
      accessibleText: undefined,
    },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("window-capture-thread")),
      accessibleText: "const answer = 42;",
    },
  ])(
    "preserves capture contents for $target before a stalled animation finishes ($accessibleText)",
    async ({ target, accessibleText }) => {
      vi.useFakeTimers();
      const never = new Promise<void>(() => undefined);
      const animationFrames: Array<FrameRequestCallback> = [];
      const acknowledgeWindowCapture = vi.fn(async () => undefined);
      const bridge = {
        requestWindowCapturePermissions: vi.fn(async () => undefined),
        getWindowCaptureState: vi.fn(),
        checkWindowCaptureShortcut: vi.fn(),
        setWindowCaptureShortcutSuppressed: vi.fn(async () => undefined),
        captureWindow: vi.fn(async () => undefined),
        listPendingWindowCaptures: vi.fn(async () => []),
        readWindowCapture: vi.fn(async () => ({
          id: "12345678-1234-1234-1234-123456789abc",
          name: "window.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,AQID",
          source: {
            kind: "window-capture" as const,
            capturedAt: "2026-09-01T00:00:00.000Z",
            appName: "Editor",
            windowTitle: "main.ts",
            ...(accessibleText ? { accessibleText } : {}),
          },
        })),
        acknowledgeWindowCapture,
        setWindowCaptureAnimationDestination: vi.fn(() => never),
        onMenuAction: vi.fn(() => () => undefined),
      } as unknown as DesktopWindowCaptureBridge;
      const item: DesktopPendingWindowCapture = {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "window.png",
        mimeType: "image/png",
        sizeBytes: 3,
        source: {
          kind: "window-capture",
          capturedAt: "2026-09-01T00:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
          ...(accessibleText ? { accessibleText } : {}),
        },
      };
      vi.stubGlobal("window", {
        desktopBridge: bridge,
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({
          backgroundColor: "rgb(0, 0, 0)",
          borderTopColor: "rgb(255, 255, 255)",
          borderTopLeftRadius: "8px",
          borderTopWidth: "1px",
        }),
        dispatchEvent: vi.fn(),
      });
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });

      if (typeof target === "string") {
        useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, target, {
          threadId: ThreadId.make("window-capture-draft-thread"),
        });
      }
      beginWindowCaptureAnimation(item.id, target);
      setWindowCaptureAnimationDestination(
        item.id,
        {
          isConnected: true,
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 208, height: 112 }),
        } as HTMLElement,
        item.source,
      );

      const delivery = deliverWindowCapture(bridge, item, target);
      await vi.advanceTimersByTimeAsync(0);

      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      expect(draft?.images).toHaveLength(1);
      expect(draft?.images[0]?.source).toEqual(item.source);
      expect(getPendingWindowCaptureAnimations()).toHaveLength(1);
      expect(acknowledgeWindowCapture).not.toHaveBeenCalled();

      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      animationFrames.shift()?.(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getPendingWindowCaptureAnimations()).toHaveLength(0);
      expect(acknowledgeWindowCapture).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      expect(acknowledgeWindowCapture).not.toHaveBeenCalled();
      animationFrames.shift()?.(0);
      await delivery;
      expect(acknowledgeWindowCapture).toHaveBeenCalledWith(item.id);
    },
  );
});

describe("window capture target resolution", () => {
  it("shares bare-route draft creation between animation start and capture drain", async () => {
    const draftId = DraftId.make("window-capture-draft");
    let finishResolution: ((target: DraftId) => void) | undefined;
    const resolveTarget = vi.fn(
      () =>
        new Promise<DraftId>((resolve) => {
          finishResolution = resolve;
        }),
    );
    const resolutionRef: { current: Promise<DraftId | null> | null } = { current: null };

    const animationTarget = resolveWindowCaptureTargetOnce(resolutionRef, resolveTarget);
    const attachmentTarget = resolveWindowCaptureTargetOnce(resolutionRef, resolveTarget);

    expect(animationTarget).toBe(attachmentTarget);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    finishResolution?.(draftId);
    await expect(animationTarget).resolves.toBe(draftId);
    expect(resolutionRef.current).toBeNull();
  });

  it("follows a draft to its promoted server thread", () => {
    const draftId = DraftId.make("window-capture-draft");
    const promotedRef = scopeThreadRef(
      environmentId,
      ThreadId.make("window-capture-promoted-thread"),
    );
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("window-capture-draft-thread"),
    });
    store.markDraftThreadPromoting(draftId, promotedRef);

    expect(resolveExistingWindowCaptureTarget(draftId, null)).toEqual(promotedRef);
  });

  it("keeps the routed server thread before its shell loads", () => {
    const routeThreadRef = scopeThreadRef(
      environmentId,
      ThreadId.make("window-capture-routed-thread"),
    );

    expect(resolveExistingWindowCaptureTarget(routeThreadRef, routeThreadRef)).toEqual(
      routeThreadRef,
    );
  });
});
