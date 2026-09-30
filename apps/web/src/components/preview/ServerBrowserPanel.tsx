import { useAtomValue } from "@effect/atom-react";
import type {
  PreviewServerBrowserInput,
  PreviewServerBrowserInstallation,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Globe } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import { isServerBrowserInstallationRequired } from "~/browser/openFileInPreview";
import {
  removeUrlForThread,
  recordVisitForThread,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { applyPreviewServerSnapshot, useThreadPreviewState } from "~/previewStateStore";
import { useEnvironment } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { subscribePreviewAction } from "./previewActionBus";
import {
  SERVER_BROWSER_INSTALL_REQUEST_FAILED,
  serverBrowserInstallationStatus,
  useServerBrowserInstallation,
} from "./serverBrowserInstallation";

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
  const environmentLabel = useEnvironment(threadRef.environmentId)?.label ?? "this environment";
  const browser = useServerBrowserInstallation(threadRef.environmentId);
  const installed = browser.statusFailed || browser.installation?.state === "installed";
  const [installDismissed, setInstallDismissed] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const requestedUrl = state.recentlySeenUrls[0] ?? null;
  const [promptedUrl, setPromptedUrl] = useState<string | null | undefined>(undefined);
  if (browser.installation && !installed && !snapshot && promptedUrl !== requestedUrl) {
    setPromptedUrl(requestedUrl);
    if (requestedUrl !== null) {
      setPendingUrl(requestedUrl);
      setInstallDismissed(false);
    }
  }
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
  const url = snapshot
    ? snapshot.navStatus._tag === "Idle"
      ? ""
      : snapshot.navStatus.url
    : (pendingUrl ?? "");
  const run = async (action: PreviewServerBrowserInput["action"]) => {
    if (!snapshot) return;
    const result = await control({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId: snapshot.tabId, action },
    });
    setError(result._tag === "Failure" ? "The browser action failed. Try again." : null);
  };
  const submit = async (url: string) => {
    if (!snapshot && !installed) {
      setPendingUrl(url);
      setInstallDismissed(false);
      return;
    }
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
      } else {
        if (isServerBrowserInstallationRequired(result.cause)) {
          setPendingUrl(url);
          setInstallDismissed(false);
        } else setError("Could not open the server browser. Check this environment and retry.");
      }
    } finally {
      setOpening(false);
    }
  };
  const openPendingUrl = useEffectEvent(() => {
    if (pendingUrl === null) return;
    setPendingUrl(null);
    void submit(pendingUrl);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The server stream reports when the install finishes.
    if (installed) openPendingUrl();
  }, [installed]);
  const installation = browser.installation;
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
      ) : snapshot ? null : !installed && installation === null ? (
        <p className="p-4 text-sm text-muted-foreground">Checking the server browser…</p>
      ) : !installed && installation && (!installDismissed || browser.installing) ? (
        <ServerBrowserInstallPrompt
          environmentLabel={environmentLabel}
          installation={installation}
          installing={browser.installing}
          requestFailed={browser.requestFailed}
          pendingUrl={pendingUrl}
          onInstall={() => void browser.install()}
          onLater={() => {
            setInstallDismissed(true);
            setPendingUrl(null);
          }}
        />
      ) : (
        <PreviewEmptyState
          threadRef={threadRef}
          environmentId={threadRef.environmentId}
          configuredUrls={configuredUrls}
          recentEntries={recentEntries}
          onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
          onOpenUrl={(url) => void submit(url)}
        />
      )}
    </div>
  );
}

function ServerBrowserInstallPrompt({
  environmentLabel,
  installation,
  installing,
  requestFailed,
  pendingUrl,
  onInstall,
  onLater,
}: {
  environmentLabel: string;
  installation: PreviewServerBrowserInstallation;
  installing: boolean;
  requestFailed: boolean;
  pendingUrl: string | null;
  onInstall: () => void;
  onLater: () => void;
}) {
  const failed = !installing && installation.state === "failed";
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <Globe className="size-4.5 text-muted-foreground" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          {installing
            ? `Installing browser on ${environmentLabel}`
            : failed
              ? "Browser install failed"
              : `Install a browser on ${environmentLabel}?`}
        </EmptyTitle>
        {installing ? (
          <EmptyDescription role="status">
            {installation.state === "installing"
              ? serverBrowserInstallationStatus(installation)
              : "Starting install…"}{" "}
            {pendingUrl ? `${pendingUrl} opens when it finishes.` : "You can close this panel."}
          </EmptyDescription>
        ) : failed ? (
          <EmptyDescription role="alert">
            {serverBrowserInstallationStatus(installation)}
          </EmptyDescription>
        ) : (
          <EmptyDescription>
            Pages for this environment load in a browser on {environmentLabel}. It uses about 300 MB
            of storage there.
          </EmptyDescription>
        )}
      </EmptyHeader>
      {installing ? null : (
        <EmptyContent>
          <div className="flex gap-2">
            <Button size="sm" onClick={onInstall}>
              {failed ? "Retry" : "Install browser"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onLater}>
              Later
            </Button>
          </div>
          {requestFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {SERVER_BROWSER_INSTALL_REQUEST_FAILED}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            You can also install it from Settings &gt; Integrations.
          </p>
        </EmptyContent>
      )}
    </Empty>
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
