import type { EnvironmentId, IssueActivity, IssueDetail } from "@t3tools/contracts";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

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
  SourceControlMetaLine: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/DetailTabStrip", () => ({
  CondensedDetailTabStrip: () => null,
  DetailTabStrip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/ListGhosts", () => ({
  DetailGhost: () => null,
  TimelineGhost: () => null,
}));
vi.mock("./IssueSummaryTab", () => ({ IssueSummaryTab: () => null }));
vi.mock("./IssueTimelineTab", () => ({ IssueTimelineTab: () => null }));
vi.mock("./IssuesUnavailableState", () => ({ IssuesUnavailableState: () => null }));
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
import { Menu, MenuItem } from "../ui/menu";

function textContent(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isValidElement(node) ? textContent(node.props.children) : "";
}

describe("IssueDetailPanel provider labels", () => {
  it("renders Linear labels in the header, tooltips, menu, and aria attributes", () => {
    hooks.reset();
    hooks.beginRender();
    const panel = IssueDetailPanel({
      environmentId: "environment-1" as EnvironmentId,
      reference: {
        projectId: "project-1" as IssueDetail["projectId"],
        repository: "acme/project",
        number: 42,
      },
      handoffTarget: { kind: "new-thread" },
    });
    const menu = visitElements(panel, (element) => element.type === Menu);
    expect(menu).not.toBeNull();

    const panelMarkup = renderToStaticMarkup(panel);
    const menuItem = visitElements(
      menu,
      (element) =>
        element.type === MenuItem && textContent(element.props.children).includes("Open on Linear"),
    );
    const markup = renderToStaticMarkup(cloneElement(menu!, { open: true }));

    expect(panelMarkup).toContain('aria-label="Open on Linear"');
    expect(menuItem).not.toBeNull();
    expect(textContent(menuItem?.props.children)).toContain("Open on Linear");
    // Base UI portals do not emit popup contents during SSR; the real open root still renders
    // here, while the MenuItem assertion above checks the child mounted in that root.
    expect(markup).toContain('aria-haspopup="menu"');
  });
});
