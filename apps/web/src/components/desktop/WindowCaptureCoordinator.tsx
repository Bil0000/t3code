import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { readThreadShell } from "../../state/entities";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginWindowCaptureAnimation,
  dismissAllWindowCaptureAnimations,
  dismissWindowCaptureAnimation,
  finishWindowCaptureAnimation,
  updateWindowCaptureAnimationSource,
  waitForWindowCaptureAnimationDestination,
} from "../../lib/windowCaptureAnimation";
import { playWindowCaptureSound } from "../../lib/windowCaptureSound";
import {
  dispatchWindowCaptureComposerFocus,
  getDesktopWindowCaptureBridge,
} from "../../lib/desktopWindowCapture";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;

export function resolveExistingWindowCaptureTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  const targetIsCurrentRoute =
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId;
  return targetIsCurrentRoute ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

const WINDOW_CAPTURE_STARTED_ACTION_PREFIX = "window-capture-started:";
const NEXT_PAINT_FALLBACK_MS = 100;

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export function WindowCaptureCoordinator() {
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  } = useHandleNewThread();
  const playSound = useClientSettings((settings) => settings.windowCapturePlaySound);
  const animateCaptures = useClientSettings((settings) => settings.windowCaptureAnimations);
  const lastTargetRef = useRef<CaptureTarget | null>(null);
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());

  const currentTarget = routeThreadRef ?? routeDraftId;
  if (currentTarget) lastTargetRef.current = currentTarget;

  const resolveTarget = useCallback(async (): Promise<CaptureTarget | null> => {
    const lastTarget = lastTargetRef.current;
    if (lastTarget) {
      const existingTarget = resolveExistingWindowCaptureTarget(lastTarget, routeThreadRef);
      if (existingTarget) {
        lastTargetRef.current = existingTarget;
        return existingTarget;
      }
      lastTargetRef.current = null;
    }
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    if (!projectRef) return null;
    const created = await handleNewThread(projectRef);
    if (!created) return null;
    lastTargetRef.current = created.draftId;
    return created.draftId;
  }, [activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef]);

  const resolveCaptureTarget = useCallback((): Promise<CaptureTarget | null> => {
    if (targetResolutionRef.current) return targetResolutionRef.current;
    const resolution = resolveTarget().finally(() => {
      if (targetResolutionRef.current === resolution) targetResolutionRef.current = null;
    });
    targetResolutionRef.current = resolution;
    return resolution;
  }, [resolveTarget]);

  const playCaptureSound = useCallback(
    (id: string) => {
      if (!playSound || soundedCaptureIdsRef.current.has(id)) return;
      soundedCaptureIdsRef.current.add(id);
      try {
        playWindowCaptureSound();
      } catch {}
    },
    [playSound],
  );

  const drain = useCallback(async () => {
    const bridge = getDesktopWindowCaptureBridge();
    if (!bridge) return;
    if (drainingRef.current) {
      rerunRequestedRef.current = true;
      return drainingRef.current;
    }

    const operation = (async () => {
      do {
        rerunRequestedRef.current = false;
        const pending = await bridge.listPendingWindowCaptures();
        for (const item of pending) {
          playCaptureSound(item.id);
          const target = await resolveCaptureTarget();
          if (!target) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Window captured, but no project is available",
                description: "Add a project, then capture the window again.",
              }),
            );
            return;
          }

          try {
            const store = useComposerDraftStore.getState();
            const existing = store.getComposerDraft(target);
            if (existing?.persistedAttachments.some((attachment) => attachment.id === item.id)) {
              await bridge.acknowledgeWindowCapture(item.id);
              finishWindowCaptureAnimation(item.id);
              soundedCaptureIdsRef.current.delete(item.id);
              continue;
            }

            updateWindowCaptureAnimationSource(item.id, item.source);
            await afterNextPaint();
            await waitForWindowCaptureAnimationDestination(item.id);

            const capture = await bridge.readWindowCapture(item.id);
            const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
            const compressed = await compressImageToByteLimit(
              original,
              PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
            );
            if (!compressed.ok) {
              await bridge.acknowledgeWindowCapture(item.id);
              finishWindowCaptureAnimation(item.id);
              throw new Error("The captured window is too large to attach.");
            }
            const file = compressed.file;
            const dataUrl = compressed.recompressed
              ? await readFileAsDataUrl(file)
              : capture.dataUrl;
            store.addImage(target, {
              type: "image",
              id: capture.id,
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              previewUrl: dataUrl,
              file,
              source: capture.source,
            });
            const persisted: PersistedComposerImageAttachment = {
              id: capture.id,
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              dataUrl,
              source: capture.source,
            };
            const persistedAttachments =
              store
                .getComposerDraft(target)
                ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
            store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
            await afterNextPaint();
            if (
              !store
                .getComposerDraft(target)
                ?.persistedAttachments.some(({ id }) => id === capture.id)
            ) {
              throw new Error("The captured window could not be saved to the draft.");
            }
            finishWindowCaptureAnimation(capture.id);
            await afterNextPaint();
            await bridge.acknowledgeWindowCapture(capture.id);
            soundedCaptureIdsRef.current.delete(capture.id);
            dispatchWindowCaptureComposerFocus();
          } catch (error) {
            await dismissWindowCaptureAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Window capture failed",
                description: error instanceof Error ? error.message : "Try the capture again.",
              }),
            );
          }
        }
      } while (rerunRequestedRef.current);
    })()
      .catch((error: unknown) => {
        dismissAllWindowCaptureAnimations();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Window capture failed",
            description: error instanceof Error ? error.message : "Try the capture again.",
          }),
        );
      })
      .finally(() => {
        drainingRef.current = null;
      });
    drainingRef.current = operation;
    return operation;
  }, [playCaptureSound, resolveCaptureTarget]);

  useEffect(() => {
    const bridge = getDesktopWindowCaptureBridge();
    if (!bridge) return;
    void drain();
    return bridge.onMenuAction((action) => {
      if (action.startsWith(WINDOW_CAPTURE_STARTED_ACTION_PREFIX)) {
        const captureId = action.slice(WINDOW_CAPTURE_STARTED_ACTION_PREFIX.length);
        if (captureId) playCaptureSound(captureId);
        if (
          captureId &&
          animateCaptures &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          void resolveCaptureTarget().then((target) => {
            if (target) beginWindowCaptureAnimation(captureId, target);
          });
        }
      }
      if (action === "window-capture-ready") void drain();
      if (action === "window-capture-failed") {
        dismissAllWindowCaptureAnimations();
        soundedCaptureIdsRef.current.clear();
        void bridge.getWindowCaptureState().then((state) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Window capture failed",
              description: state.message ?? "Try the capture again.",
            }),
          );
        });
      }
    });
  }, [animateCaptures, drain, playCaptureSound, resolveCaptureTarget]);

  useEffect(() => {
    const dismissOnBlur = () => dismissAllWindowCaptureAnimations();
    const dismissWhenHidden = () => {
      if (document.visibilityState === "hidden") dismissAllWindowCaptureAnimations();
    };
    window.addEventListener("blur", dismissOnBlur);
    document.addEventListener("visibilitychange", dismissWhenHidden);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      document.removeEventListener("visibilitychange", dismissWhenHidden);
    };
  }, []);

  return null;
}
