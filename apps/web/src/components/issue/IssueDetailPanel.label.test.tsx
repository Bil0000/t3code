import type { EnvironmentId, IssueActivity, IssueDetail } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({}) },
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    detail: () => "detail",
    activity: () => "activity",
    commentsPage: "commentsPage",
    invalidate: "invalidate",
    runAction: "runAction",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? detail : activity,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../sourceControl/ActivityUnavailableState", () => ({
  ActivityUnavailableState: () => null,
}));
vi.mock("../sourceControl/actorPresentation", () => ({
  SourceControlActorLabel: () => null,
  SourceControlMetaLine: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/DetailTabStrip", () => ({
  CondensedDetailTabStrip: () => null,
  DetailTabStrip: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/ListGhosts", () => ({
  DetailGhost: () => null,
  TimelineGhost: () => null,
}));
vi.mock("./IssueSummaryTab", () => ({ IssueSummaryTab: () => null }));
vi.mock("./IssueTimelineTab", () => ({ IssueTimelineTab: () => null }));
vi.mock("./IssuesUnavailableState", () => ({ IssuesUnavailableState: () => null }));
vi.mock("../ui/menu", async () => {
  const React = await import("react");
  const Slot = ({ render, children, ...props }: any) =>
    render
      ? React.cloneElement(render, props, children)
      : React.createElement("div", props, children);
  return {
    Menu: ({ children }: any) => <div>{children}</div>,
    MenuItem: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    MenuPopup: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    MenuSeparator: () => null,
    MenuTrigger: Slot,
  };
});
vi.mock("../ui/tooltip", async () => {
  const React = await import("react");
  const Slot = ({ render, children, ...props }: any) =>
    render
      ? React.cloneElement(render, props, children)
      : React.createElement("span", props, children);
  return {
    Tooltip: ({ children }: any) => <>{children}</>,
    TooltipPopup: ({ children }: any) => <span>{children}</span>,
    TooltipTrigger: Slot,
  };
});

const detail: IssueDetail = {
  provider: "linear",
  capabilities: {
    comment: false,
    actions: [],
    closeReasons: [],
    create: false,
    issueTemplates: false,
    edit: false,
    labels: false,
    assignees: false,
    listLabelCandidates: false,
    listAssigneeCandidates: false,
    search: true,
    linkedPullRequests: false,
    timelineEvents: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    create: false,
  },
  projectId: "project-1" as IssueDetail["projectId"],
  projectTitle: "T3 Code",
  workspaceRoot: "/tmp/project",
  repository: "acme/project",
  number: 42,
  title: "A Linear issue",
  body: "",
  url: "https://linear.app/acme/issue/ABC-42",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  linkedPullRequests: [],
};

const activity: IssueActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  nextCommentsCursor: null,
  events: [],
};

import { IssueDetailPanel } from "./IssueDetailPanel";

describe("IssueDetailPanel provider labels", () => {
  it("renders Linear labels in the header, tooltips, menu, and aria attributes", () => {
    const markup = renderToStaticMarkup(
      <IssueDetailPanel
        environmentId={"environment-1" as EnvironmentId}
        reference={{
          projectId: "project-1" as IssueDetail["projectId"],
          repository: "acme/project",
          number: 42,
        }}
        handoffTarget={{ kind: "new-thread" }}
      />,
    );

    expect(markup).toContain('aria-label="Open on Linear"');
    expect(markup).toContain(">Open on Linear<");
    expect(markup.match(/Open on Linear/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
