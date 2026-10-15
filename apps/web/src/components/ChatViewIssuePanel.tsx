import type {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import type { EnvironmentPresentation } from "../state/environments";
import { IssueDetailPanel } from "./issue/IssueDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";
import { ThreadIssuesPanel } from "./threadIssue/ThreadIssuesPanel";

export function ChatViewIssuePanel({
  surface,
  threadRef,
  environmentById,
}: {
  surface: Extract<RightPanelSurface, { kind: "issue" | "issues" }>;
  threadRef: ScopedThreadRef;
  environmentById: ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "serverConfig">>;
}) {
  const environmentId =
    (surface.kind === "issue" ? (surface.environmentId as EnvironmentId | undefined) : undefined) ??
    threadRef.environmentId;
  const serverConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  if (serverConfig === null) return <PullRequestDetailGhost />;
  if (surface.kind === "issues") {
    return serverConfig.environment.capabilities.issues === true ? (
      <ThreadIssuesPanel threadRef={threadRef} />
    ) : (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Update this environment's T3 Code server to browse linked issues."
      />
    );
  }
  if (serverConfig.environment.capabilities.issues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Update this environment's T3 Code server to browse issues."
      />
    );
  }
  return (
    <IssueDetailPanel
      environmentId={environmentId}
      reference={{
        projectId: surface.projectId as ProjectId,
        tracker: surface.tracker as IssueTrackerKind,
        ...(surface.host ? { host: surface.host } : {}),
        ...(surface.connectionId === undefined ? {} : { connectionId: surface.connectionId }),
        scope: surface.scope,
        key: surface.key,
      }}
      threadRef={threadRef}
      onSelectPullRequest={(target) => {
        useRightPanelStore.getState().openPullRequest(threadRef, {
          ...target,
          ...(surface.environmentId === undefined ? {} : { environmentId: surface.environmentId }),
        });
      }}
    />
  );
}
