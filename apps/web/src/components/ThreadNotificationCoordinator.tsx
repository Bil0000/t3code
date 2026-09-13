import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

function EnvironmentNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, { input: string | null; completion: number | null }>());

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { input: string | null; completion: number | null }>();
    for (const thread of shell.snapshot.value.threads) {
      const status = resolveSidebarThreadStatus(thread);
      const prior = previous.current.get(thread.id);
      const input =
        status === "input" || status === "approval"
          ? `${thread.latestTurn?.turnId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { input, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        input && input !== prior.input
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        kind === "completion" &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
      ) {
        const toastId = toastManager.add({
          type: "success",
          title: "Thread completed",
          description: thread.title,
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(
          kind === "completion"
            ? "Thread completed"
            : status === "approval"
              ? "Approval needed"
              : "Input needed",
          { body: thread.title, tag: `${environmentId}:${thread.id}`, silent: true },
        );
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    shell,
  ]);

  return null;
}
