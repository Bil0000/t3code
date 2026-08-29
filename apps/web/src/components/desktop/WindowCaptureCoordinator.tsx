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
import { markWindowCaptureAnimation } from "../../lib/windowCaptureAnimation";
import { playWindowCaptureSound } from "../../lib/windowCaptureSound";
import {
  dispatchWindowCaptureComposerFocus,
  getDesktopWindowCaptureBridge,
} from "../../lib/desktopWindowCapture";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;

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
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);

  const currentTarget = routeThreadRef ?? routeDraftId;
  if (currentTarget) lastTargetRef.current = currentTarget;

  const resolveTarget = useCallback(async (): Promise<CaptureTarget | null> => {
    const lastTarget = lastTargetRef.current;
    if (lastTarget) {
      const store = useComposerDraftStore.getState();
      const targetExists =
        typeof lastTarget === "string"
          ? store.getDraftSession(lastTarget) !== null
          : store.getDraftSessionByRef(lastTarget) !== null || readThreadShell(lastTarget) !== null;
      if (targetExists) return lastTarget;
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
  }, [activeDraftThread, activeThread, defaultProjectRef, handleNewThread]);

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
          const target = await resolveTarget();
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
              continue;
            }

            const capture = await bridge.readWindowCapture(item.id);
            const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
            const compressed = await compressImageToByteLimit(
              original,
              PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
            );
            if (!compressed.ok) {
              await bridge.acknowledgeWindowCapture(item.id);
              throw new Error("The captured window is too large to attach.");
            }
            const file = compressed.file;
            if (animateCaptures && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
              markWindowCaptureAnimation(file);
            }
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
            await Promise.resolve();
            if (
              !store
                .getComposerDraft(target)
                ?.persistedAttachments.some(({ id }) => id === capture.id)
            ) {
              throw new Error("The captured window could not be saved to the draft.");
            }
            await bridge.acknowledgeWindowCapture(capture.id);
            if (playSound) {
              try {
                playWindowCaptureSound();
              } catch {}
            }
            dispatchWindowCaptureComposerFocus();
          } catch (error) {
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
  }, [animateCaptures, playSound, resolveTarget]);

  useEffect(() => {
    const bridge = getDesktopWindowCaptureBridge();
    if (!bridge) return;
    void drain();
    return bridge.onMenuAction((action) => {
      if (action === "window-capture-ready") void drain();
      if (action === "window-capture-failed") {
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
  }, [drain]);

  return null;
}
