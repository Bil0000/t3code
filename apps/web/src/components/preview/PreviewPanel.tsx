"use client";

import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { useServerConfigs } from "~/state/entities";
import { usePreviewSession } from "./usePreviewSession";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ServerBrowserPanel } from "./ServerBrowserPanel";
import { useThreadPreviewState } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  usePreviewSession(threadRef);
  const supportsServerBrowser =
    useServerConfigs().get(threadRef.environmentId)?.serverBrowser === true;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const state = useThreadPreviewState(threadRef);
  const snapshot = state.sessions[tabId ?? state.activeTabId ?? ""];
  if (
    snapshot?.runtime === "server" ||
    (supportsServerBrowser &&
      (!window.desktopBridge?.preview ||
        (!snapshot && threadRef.environmentId !== primaryEnvironmentId)))
  ) {
    return (
      <PreviewPanelShell mode={mode}>
        <ServerBrowserPanel
          threadRef={threadRef}
          tabId={tabId}
          visible={visible}
          configuredUrls={configuredUrls}
        />
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
