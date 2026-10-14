import { pullRequestHostOf, SourceControlProviderKind } from "@t3tools/contracts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback } from "react";

import { readIssueListPreferences } from "../components/issue/issueListPreferences";
import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { ISSUES_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs, useThreadShell } from "../state/entities";
import { issueEnvironment } from "../state/issues";
import { useAtomCommand } from "../state/use-atom-command";

export function useOpenIssueLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  targetUrl: string,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const thread = useThreadShell(threadRef ?? null);
  const resolveUrl = useAtomCommand(issueEnvironment.resolveUrl, { reportFailure: false });
  return useCallback(
    (event, targetUrl, targetEnvironmentId) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      const resolvedPanelRef = threadRef ?? (panelRef && ISSUES_PANEL_REF);
      const environmentId = targetEnvironmentId ?? threadRef?.environmentId;
      if (resolvedPanelRef === undefined || environmentId === undefined) return false;
      if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return false;
      const candidate =
        parseIssueUrl(targetUrl) !== null ||
        projects.some((project) => {
          const identity = project.repositoryIdentity;
          const tracker = identity?.provider;
          return (
            project.environmentId === environmentId &&
            tracker !== undefined &&
            tracker !== "unknown" &&
            parseIssueUrl(targetUrl, {
              tracker,
              host: pullRequestHostOf(identity, SourceControlProviderKind.make(tracker)),
            }) !== null
          );
        });
      if (!candidate) return false;
      event.preventDefault();
      event.stopPropagation();
      void resolveUrl({
        environmentId,
        input: {
          url: targetUrl,
          ...(threadRef?.environmentId === environmentId && thread !== null
            ? { projectId: thread.projectId }
            : {}),
        },
      })
        .then(async (result) => {
          if (result._tag === "Failure") {
            await readLocalApi()?.shell.openExternal(targetUrl);
            return;
          }
          const reference = result.value;
          useRightPanelStore.getState().openIssue(resolvedPanelRef, {
            ...(resolvedPanelRef.environmentId === environmentId ? {} : { environmentId }),
            projectId: reference.projectId,
            tracker: reference.tracker,
            host: reference.host,
            scope: reference.scope,
            key: reference.key,
            url: targetUrl,
          });
          if (threadRef === undefined) {
            await navigate({
              to: "/issues",
              search: {
                ...readIssueListPreferences(),
                selectedEnvironmentId: environmentId,
                selectedProjectId: reference.projectId,
                ...(reference.host === undefined ? {} : { selectedHost: reference.host }),
                tracker: reference.tracker,
                scope: reference.scope,
                key: reference.key,
              },
            });
          }
        })
        .catch(() => {
          toastManager.add({ type: "error", title: "The link could not be opened" });
        });
      return true;
    },
    [navigate, panelRef, projects, resolveUrl, serverConfigs, thread, threadRef],
  );
}
