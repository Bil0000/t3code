import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const panelMounts = vi.hoisted(() => ({
  history: vi.fn(),
  issues: vi.fn(),
  pullRequests: vi.fn(),
}));
const panelModuleLoads = vi.hoisted(() => ({
  history: 0,
  issues: 0,
  pullRequests: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    Activity: ({
      children,
      mode,
    }: {
      readonly children: ReactNode;
      readonly mode: "hidden" | "visible";
    }) => <div data-activity-mode={mode}>{children}</div>,
  };
});

import { repositoryViewFromTabKey } from "./RepositoryPanel";
import RepositoryPanel from "./RepositoryPanel";

vi.mock("./GitHistoryPanel", () => ({
  default: (() => {
    panelModuleLoads.history += 1;
    return () => {
      panelMounts.history();
      return <div data-history-panel="mounted">History content</div>;
    };
  })(),
}));

vi.mock("./issue/IssuesPanel", () => ({
  IssuesPanel: (() => {
    panelModuleLoads.issues += 1;
    return () => {
      panelMounts.issues();
      return <div>Issues content</div>;
    };
  })(),
}));

vi.mock("./pullRequest/PullRequestsPanel", () => ({
  PullRequestsPanel: (() => {
    panelModuleLoads.pullRequests += 1;
    return () => {
      panelMounts.pullRequests();
      return <div>Pull requests content</div>;
    };
  })(),
}));

describe("RepositoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads only the History panel module on an initial History view", async () => {
    renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="history"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );
    await vi.dynamicImportSettled();

    expect(panelModuleLoads).toEqual({ history: 1, issues: 0, pullRequests: 0 });
  });

  it("does not mount inactive repository views that would start hidden queries", () => {
    renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="history"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );

    expect(panelMounts.history).toHaveBeenCalledOnce();
    expect(panelMounts.issues).not.toHaveBeenCalled();
    expect(panelMounts.pullRequests).not.toHaveBeenCalled();
  });

  it("keeps the initial history view in a state-preserving activity boundary", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="history"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );

    expect(markup).toContain('data-activity-mode="visible"><div id="repository-panel-history"');
    expect(markup).not.toContain('data-activity-mode="hidden"');
  });

  it("exposes Issues beside History in the repository pane", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="history"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Repository history, issues, and pull requests"');
    expect(markup).toContain(">History</button>");
    expect(markup).toContain(">Issues</button>");
    expect(markup).toContain(">Pull Requests</button>");
    expect(markup).toContain("History content");
    expect(markup).not.toContain("Issues content");
    expect(markup).not.toContain("Pull requests content");
    expect(markup).toContain('<div id="repository-panel-history"');
  });

  it("connects tabs to their panels", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="issues"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );

    expect(markup).toContain('id="repository-tab-history"');
    expect(markup).toContain('aria-controls="repository-panel-history"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('id="repository-tab-issues"');
    expect(markup).toContain('aria-controls="repository-panel-issues"');
    expect(markup).toContain(
      'id="repository-tab-issues" aria-selected="true" aria-controls="repository-panel-issues" tabindex="0"',
    );
    expect(markup).toContain('id="repository-tab-pull-requests"');
    expect(markup).toContain('aria-controls="repository-panel-pull-requests"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-labelledby="repository-tab-issues"');
    expect(markup).toContain('<div id="repository-panel-issues"');
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(markup).toContain("Loading issues…");
    expect(markup).not.toContain("Pull requests content");
  });

  it("wraps arrow-key tab navigation and supports Home and End", () => {
    expect(repositoryViewFromTabKey("history", "ArrowLeft")).toBe("pull-requests");
    expect(repositoryViewFromTabKey("pull-requests", "ArrowRight")).toBe("history");
    expect(repositoryViewFromTabKey("pull-requests", "Home")).toBe("history");
    expect(repositoryViewFromTabKey("history", "End")).toBe("pull-requests");
    expect(repositoryViewFromTabKey("issues", "Enter")).toBeNull();
  });

  it("mounts the pull request view without mounting the other views", () => {
    const markup = renderToStaticMarkup(
      <RepositoryPanel
        environmentId={"env-1" as never}
        cwd="/work/repository"
        gitHistoryCapabilityState="ready"
        issuesCapabilityState="ready"
        pullRequestsCapabilityState="ready"
        projectId={"project-1" as never}
        composerDraftTarget={{ environmentId: "env-1", threadId: "thread-1" } as never}
        view="pull-requests"
        onViewChange={() => undefined}
        selectedIssue={null}
        onSelectIssue={() => undefined}
        selectedPullRequest={null}
        onSelectPullRequest={() => undefined}
        handoffTarget={{ kind: "new-thread" }}
        onIssueStateChange={() => undefined}
        onPullRequestStateChange={() => undefined}
        onOpenLinkedIssue={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />,
    );

    expect(markup).toContain("Loading pull requests…");
    expect(markup).not.toContain('data-history-panel="mounted"');
    expect(markup).toContain('<div id="repository-panel-pull-requests"');
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(1);
  });
});
