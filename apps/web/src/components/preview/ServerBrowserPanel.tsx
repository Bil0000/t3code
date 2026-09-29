import { useAtomValue } from "@effect/atom-react";
import type { PreviewServerBrowserInput, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";

import {
  removeUrlForThread,
  recordVisitForThread,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import { applyPreviewServerSnapshot, useThreadPreviewState } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { subscribePreviewAction } from "./previewActionBus";

export function ServerBrowserPanel({
  threadRef,
  tabId,
  visible,
  configuredUrls,
}: {
  threadRef: ScopedThreadRef;
  tabId?: string | null | undefined;
  visible: boolean;
  configuredUrls?: ReadonlyArray<string> | undefined;
}) {
  const state = useThreadPreviewState(threadRef);
  const snapshot = state.sessions[tabId ?? state.activeTabId ?? ""];
  const open = useAtomCommand(previewEnvironment.open);
  const navigate = useAtomCommand(previewEnvironment.navigate);
  const refresh = useAtomCommand(previewEnvironment.refresh);
  const close = useAtomCommand(previewEnvironment.close);
  const control = useAtomCommand(previewEnvironment.serverBrowserControl);
  const recentEntries = useThreadRecentHistory(threadRef, 8);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [focusUrlNonce, setFocusUrlNonce] = useState(0);
  const handleRefresh = useCallback(() => {
    if (snapshot)
      void refresh({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
      });
  }, [snapshot, refresh, threadRef]);
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      if (action === "refresh") handleRefresh();
      if (action === "focus-url") setFocusUrlNonce((value) => value + 1);
    });
  }, [visible, handleRefresh]);
  const url = snapshot?.navStatus._tag === "Idle" ? "" : (snapshot?.navStatus.url ?? "");
  const run = async (action: PreviewServerBrowserInput["action"]) => {
    if (!snapshot) return;
    const result = await control({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId: snapshot.tabId, action },
    });
    setError(result._tag === "Failure" ? "The browser action failed. Try again." : null);
  };
  const submit = async (url: string) => {
    setOpening(true);
    setError(null);
    try {
      const input = {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, url, runtime: "server" as const },
      };
      const result = snapshot
        ? await navigate({ ...input, input: { ...input.input, tabId: snapshot.tabId } })
        : await open(input);
      if (result._tag === "Success") {
        applyPreviewServerSnapshot(threadRef, result.value);
        recordVisitForThread(threadRef, url);
      } else setError("Could not open the server browser. Check this environment and retry.");
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewChromeRow
        url={url}
        loading={opening || snapshot?.navStatus._tag === "Loading"}
        canGoBack={snapshot?.canGoBack ?? false}
        canGoForward={snapshot?.canGoForward ?? false}
        refreshDisabled={!snapshot}
        inputDisabled={opening}
        focusUrlNonce={focusUrlNonce}
        onBack={() => void run({ _tag: "back" })}
        onForward={() => void run({ _tag: "forward" })}
        onRefresh={handleRefresh}
        onSubmit={(url) => void submit(url)}
        leadingActions={<span className="text-xs text-muted-foreground">Server</span>}
        trailingActions={
          snapshot ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void close({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
                })
              }
            >
              Close
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {snapshot?.navStatus._tag === "LoadFailed" ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          Could not load this page. Check the URL and dev server, then retry.
        </p>
      ) : null}
      {snapshot && visible ? (
        <ServerBrowserFrame
          threadRef={threadRef}
          tabId={snapshot.tabId}
          onAction={run}
          onExit={() => setFocusUrlNonce((value) => value + 1)}
        />
      ) : !snapshot ? (
        <PreviewEmptyState
          threadRef={threadRef}
          environmentId={threadRef.environmentId}
          configuredUrls={configuredUrls}
          recentEntries={recentEntries}
          onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
          onOpenUrl={(url) => void submit(url)}
        />
      ) : null}
    </div>
  );
}

function ServerBrowserFrame({
  threadRef,
  tabId,
  onAction,
  onExit,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  onAction: (action: PreviewServerBrowserInput["action"]) => Promise<void>;
  onExit: () => void;
}) {
  const frame = useAtomValue(
    previewEnvironment.serverBrowserFrames({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId },
    }),
  );
  if (frame._tag === "Failure")
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        The browser view disconnected. Reopen this panel to reconnect.
      </p>
    );
  if (!AsyncResult.isSuccess(frame))
    return <p className="p-4 text-sm text-muted-foreground">Connecting to the server browser…</p>;
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-white">
      <img
        src={`data:image/jpeg;base64,${frame.value.data}`}
        alt="Server browser. Click to interact. Press Shift+Escape to return to the URL."
        role="button"
        draggable={false}
        tabIndex={0}
        className="max-h-full max-w-full object-contain object-top outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          void onAction({
            _tag: "click",
            x: ((event.clientX - rect.left) * frame.value.width) / rect.width,
            y: ((event.clientY - rect.top) * frame.value.height) / rect.height,
          });
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
          if (event.shiftKey && event.key === "Escape") {
            event.preventDefault();
            onExit();
            return;
          }
          if (
            ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
            (event.shiftKey && event.key === "Insert")
          )
            return;
          event.preventDefault();
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
            void onAction({ _tag: "type", text: event.key });
          else
            void onAction({
              _tag: "press",
              key: [
                event.ctrlKey && "Control",
                event.metaKey && "Meta",
                event.altKey && "Alt",
                event.shiftKey && "Shift",
                event.key,
              ]
                .filter(Boolean)
                .join("+"),
            });
        }}
        onPaste={(event) => {
          event.stopPropagation();
          event.preventDefault();
          void onAction({ _tag: "type", text: event.clipboardData.getData("text") });
        }}
        onWheel={(event) =>
          void onAction({ _tag: "scroll", deltaX: event.deltaX, deltaY: event.deltaY })
        }
      />
    </div>
  );
}
