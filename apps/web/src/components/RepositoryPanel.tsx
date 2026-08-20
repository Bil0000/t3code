import type {
  EnvironmentId,
  IssueLink,
  IssueLinkedPullRequest,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Activity, lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { DraftId } from "~/composerDraftStore";
import type { RepositoryItemSelection, RepositoryView } from "~/rightPanelStore";

import type { IssueHandoffTarget } from "./issue/IssueDetailPanel";
import type { IssueTabStatus, PullRequestTabStatus } from "./RightPanelTabs";
import { Button } from "./ui/button";

const GitHistoryPanel = lazy(() => import("./GitHistoryPanel"));
const IssuesPanel = lazy(() =>
  import("./issue/IssuesPanel").then(({ IssuesPanel }) => ({ default: IssuesPanel })),
);
const PullRequestsPanel = lazy(() =>
  import("./pullRequest/PullRequestsPanel").then(({ PullRequestsPanel }) => ({
    default: PullRequestsPanel,
  })),
);

interface RepositoryPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly issueUrlPrefix?: string;
  readonly gitHistoryCapabilityState: "unavailable" | "ready";
  readonly issuesCapabilityState: "loading" | "unavailable" | "ready";
  readonly pullRequestsCapabilityState: "loading" | "unavailable" | "ready";
  readonly projectId: ProjectId;
  readonly handoffTarget: IssueHandoffTarget;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly view: RepositoryView;
  readonly onViewChange: (view: RepositoryView) => void;
  readonly selectedIssue: RepositoryItemSelection | null;
  readonly onSelectIssue: (target: RepositoryItemSelection | null) => void;
  readonly selectedPullRequest: RepositoryItemSelection | null;
  readonly onSelectPullRequest: (target: RepositoryItemSelection | null) => void;
  readonly onIssueStateChange: (status: IssueTabStatus) => void;
  readonly onPullRequestStateChange: (status: PullRequestTabStatus) => void;
  readonly onOpenLinkedIssue: (link: IssueLink) => void;
  readonly onOpenLinkedPullRequest: (link: IssueLinkedPullRequest) => void;
}

const repositoryViews = [
  "history",
  "issues",
  "pull-requests",
] as const satisfies ReadonlyArray<RepositoryView>;

export function repositoryViewFromTabKey(view: RepositoryView, key: string): RepositoryView | null {
  const currentIndex = repositoryViews.indexOf(view);
  if (key === "ArrowRight") {
    return repositoryViews[(currentIndex + 1) % repositoryViews.length] ?? null;
  }
  if (key === "ArrowLeft") {
    return (
      repositoryViews[(currentIndex - 1 + repositoryViews.length) % repositoryViews.length] ?? null
    );
  }
  if (key === "Home") return repositoryViews[0] ?? null;
  if (key === "End") return repositoryViews[repositoryViews.length - 1] ?? null;
  return null;
}

export function repositoryViewsAfterActivation(
  activatedViews: ReadonlySet<RepositoryView>,
  view: RepositoryView,
): ReadonlySet<RepositoryView> {
  if (activatedViews.has(view)) return activatedViews;
  return new Set([...activatedViews, view]);
}

function repositoryTabId(view: RepositoryView): string {
  return `repository-tab-${view}`;
}

function repositoryPanelId(view: RepositoryView): string {
  return `repository-panel-${view}`;
}

function RepositoryPanelLoadingFallback(props: { readonly children: string }) {
  return (
    <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

export default function RepositoryPanel(props: RepositoryPanelProps) {
  const mode = props.view;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activatedViews, setActivatedViews] = useState<ReadonlySet<RepositoryView>>(
    () => new Set([mode]),
  );
  const mountedViews = repositoryViewsAfterActivation(activatedViews, mode);

  useEffect(() => {
    setActivatedViews((views) => repositoryViewsAfterActivation(views, mode));
  }, [mode]);

  const activateView = (view: RepositoryView) => {
    setActivatedViews((views) => repositoryViewsAfterActivation(views, view));
    props.onViewChange(view);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, view: RepositoryView) => {
    const nextView = repositoryViewFromTabKey(view, event.key);
    if (nextView === null) return;

    event.preventDefault();
    activateView(nextView);
    tabRefs.current[repositoryViews.indexOf(nextView)]?.focus();
  };

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Repository history, issues, and pull requests"
    >
      <div
        className="flex shrink-0 items-center gap-1 border-b border-border/70 px-3 py-1.5"
        role="tablist"
        aria-label="Repository views"
      >
        <Button
          size="xs"
          variant={mode === "history" ? "secondary" : "ghost"}
          role="tab"
          ref={(node) => {
            tabRefs.current[0] = node;
          }}
          id={repositoryTabId("history")}
          aria-selected={mode === "history"}
          aria-controls={repositoryPanelId("history")}
          tabIndex={mode === "history" ? 0 : -1}
          onKeyDown={(event) => handleTabKeyDown(event, "history")}
          onClick={() => activateView("history")}
        >
          History
        </Button>
        <Button
          size="xs"
          variant={mode === "issues" ? "secondary" : "ghost"}
          role="tab"
          ref={(node) => {
            tabRefs.current[1] = node;
          }}
          id={repositoryTabId("issues")}
          aria-selected={mode === "issues"}
          aria-controls={repositoryPanelId("issues")}
          tabIndex={mode === "issues" ? 0 : -1}
          onKeyDown={(event) => handleTabKeyDown(event, "issues")}
          onClick={() => activateView("issues")}
        >
          Issues
        </Button>
        <Button
          size="xs"
          variant={mode === "pull-requests" ? "secondary" : "ghost"}
          role="tab"
          ref={(node) => {
            tabRefs.current[2] = node;
          }}
          id={repositoryTabId("pull-requests")}
          aria-selected={mode === "pull-requests"}
          aria-controls={repositoryPanelId("pull-requests")}
          tabIndex={mode === "pull-requests" ? 0 : -1}
          onKeyDown={(event) => handleTabKeyDown(event, "pull-requests")}
          onClick={() => activateView("pull-requests")}
        >
          Pull Requests
        </Button>
      </div>

      {mountedViews.has("history") && (
        <Activity mode={mode === "history" ? "visible" : "hidden"}>
          <div
            id={repositoryPanelId("history")}
            role="tabpanel"
            aria-labelledby={repositoryTabId("history")}
            className="min-h-0 flex-1"
          >
            {props.gitHistoryCapabilityState === "ready" ? (
              <Suspense
                fallback={
                  <RepositoryPanelLoadingFallback>
                    Loading Git History…
                  </RepositoryPanelLoadingFallback>
                }
              >
                <GitHistoryPanel
                  environmentId={props.environmentId}
                  cwd={props.cwd}
                  active={mode === "history"}
                  {...(props.issueUrlPrefix ? { issueUrlPrefix: props.issueUrlPrefix } : {})}
                />
              </Suspense>
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Update the environment server to browse Git History.
              </div>
            )}
          </div>
        </Activity>
      )}

      {mountedViews.has("issues") && (
        <Activity mode={mode === "issues" ? "visible" : "hidden"}>
          <div
            id={repositoryPanelId("issues")}
            role="tabpanel"
            aria-labelledby={repositoryTabId("issues")}
            className="min-h-0 flex-1"
          >
            {props.issuesCapabilityState === "loading" ? (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Loading issues…
              </div>
            ) : props.issuesCapabilityState === "unavailable" ? (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Update the environment server to browse issues.
              </div>
            ) : (
              <Suspense
                fallback={
                  <RepositoryPanelLoadingFallback>Loading issues…</RepositoryPanelLoadingFallback>
                }
              >
                <IssuesPanel
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  selected={props.selectedIssue}
                  onSelect={props.onSelectIssue}
                  handoffTarget={props.handoffTarget}
                  onStateChange={props.onIssueStateChange}
                  onOpenLinkedPullRequest={props.onOpenLinkedPullRequest}
                />
              </Suspense>
            )}
          </div>
        </Activity>
      )}

      {mountedViews.has("pull-requests") && (
        <Activity mode={mode === "pull-requests" ? "visible" : "hidden"}>
          <div
            id={repositoryPanelId("pull-requests")}
            role="tabpanel"
            aria-labelledby={repositoryTabId("pull-requests")}
            className="min-h-0 flex-1"
          >
            {props.pullRequestsCapabilityState === "loading" ? (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Loading pull requests…
              </div>
            ) : props.pullRequestsCapabilityState === "unavailable" ? (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Update the environment server to browse pull requests.
              </div>
            ) : (
              <Suspense
                fallback={
                  <RepositoryPanelLoadingFallback>
                    Loading pull requests…
                  </RepositoryPanelLoadingFallback>
                }
              >
                <PullRequestsPanel
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  selected={
                    props.selectedPullRequest === null
                      ? null
                      : {
                          ...props.selectedPullRequest,
                          projectId: props.selectedPullRequest.projectId as ProjectId,
                        }
                  }
                  onSelect={props.onSelectPullRequest}
                  composerDraftTarget={props.composerDraftTarget}
                  onStateChange={props.onPullRequestStateChange}
                  onOpenLinkedIssue={props.onOpenLinkedIssue}
                />
              </Suspense>
            )}
          </div>
        </Activity>
      )}
    </section>
  );
}
