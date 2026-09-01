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
  deliverWindowCapture,
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
        callback(0);
        return 1;
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

      await deliverWindowCapture(bridge, item, target);

      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      expect(draft?.images).toHaveLength(1);
      expect(draft?.images[0]?.source).toEqual(item.source);
      expect(acknowledgeWindowCapture).toHaveBeenCalledWith(item.id);
      expect(getPendingWindowCaptureAnimations()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(getPendingWindowCaptureAnimations()).toHaveLength(0);
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
