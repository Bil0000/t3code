import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const navigation = vi.hoisted(() => vi.fn<(options: unknown) => void>());
const rightPanel = vi.hoisted(() => ({ openRepository: vi.fn() }));
const routeState = vi.hoisted(() => ({
  params: { environmentId: "environment-1", threadId: "thread-1" } as Record<string, string>,
  draftSession: null as {
    environmentId: string;
    threadId: string;
    projectId: string;
    promotedTo: null;
  } | null,
  project: { repositoryIdentity: { canonicalKey: "github:acme/repository" } as object | null },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@tanstack/react-router", () => ({
  Link: "a",
  useLocation: (options: { select: (location: { pathname: string }) => unknown }) =>
    options.select({ pathname: "/" }),
  useNavigate: () => navigation,
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select(routeState.params),
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: { getDraftSession: () => typeof routeState.draftSession }) => unknown,
  ) => select({ getDraftSession: () => routeState.draftSession }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-1",
        serverConfig: { environment: { capabilities: { issues: true, pullRequests: true } } },
      },
    ],
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "environment-1", id: "project-1", ...routeState.project }],
  useThreadShell: () =>
    routeState.params.threadId === "thread-1"
      ? { environmentId: "environment-1", projectId: "project-1" }
      : null,
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => rightPanel },
}));
vi.mock("../ui/sidebar", () => ({
  SidebarFooter: "footer",
  SidebarHeader: "header",
  SidebarMenu: "menu",
  SidebarMenuButton: "button",
  SidebarMenuItem: "item",
  SidebarTrigger: "button",
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip",
  TooltipPopup: "tooltip-popup",
  TooltipTrigger: "tooltip-trigger",
}));

import { SidebarChromeFooter } from "./SidebarChrome";

function footerAction(label: "Issues" | "Pull Requests"): () => void {
  hooks.beginRender();
  const footer = SidebarChromeFooter.type();
  const button = visitElements(footer, (element) => element.props["aria-label"] === label);
  if (button === null || typeof button.props.onClick !== "function") {
    throw new Error(`Could not find the ${label} footer action.`);
  }
  return button.props.onClick as () => void;
}

describe("SidebarChromeFooter repository navigation", () => {
  beforeEach(() => {
    hooks.reset();
    navigation.mockReset();
    rightPanel.openRepository.mockReset();
    routeState.params = { environmentId: "environment-1", threadId: "thread-1" };
    routeState.draftSession = null;
    routeState.project = { repositoryIdentity: { canonicalKey: "github:acme/repository" } };
  });

  it("opens the active repository's pull requests in the repository pane", () => {
    footerAction("Pull Requests")();

    expect(rightPanel.openRepository).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "environment-1", threadId: "thread-1" }),
      "pull-requests",
    );
    expect(navigation).not.toHaveBeenCalled();
  });

  it("falls back to global issues when the active project has no repository identity", () => {
    routeState.project = { repositoryIdentity: null };

    footerAction("Issues")();

    expect(rightPanel.openRepository).not.toHaveBeenCalled();
    expect(navigation).toHaveBeenCalledWith({
      to: "/issues",
      search: { involvement: "all", state: "open" },
    });
  });

  it("opens repository actions for an unpromoted draft in its project", () => {
    routeState.params = { draftId: "draft-1" };
    routeState.draftSession = {
      environmentId: "environment-1",
      threadId: "draft-thread-1",
      projectId: "project-1",
      promotedTo: null,
    };

    footerAction("Issues")();
    footerAction("Pull Requests")();

    expect(rightPanel.openRepository).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "environment-1", threadId: "draft-thread-1" }),
      "issues",
    );
    expect(rightPanel.openRepository).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "environment-1", threadId: "draft-thread-1" }),
      "pull-requests",
    );
    expect(navigation).not.toHaveBeenCalled();
  });
});
