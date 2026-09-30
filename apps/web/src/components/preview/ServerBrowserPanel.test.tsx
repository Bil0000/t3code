import { EnvironmentId, ThreadId, type PreviewServerBrowserInstallation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  installation: null as PreviewServerBrowserInstallation | null,
  recentlySeenUrls: [] as string[],
  install: vi.fn(),
  open: vi.fn(),
}));

vi.mock("./serverBrowserInstallation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serverBrowserInstallation")>()),
  useServerBrowserInstallation: () => ({
    installation: mocks.installation,
    statusFailed: false,
    requestFailed: false,
    installing: mocks.installation?.state === "installing",
    install: mocks.install,
  }),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => ({ label: "devbox" }) }));
vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: vi.fn(),
  removeUrlForThread: vi.fn(),
  useThreadRecentHistory: () => [],
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    sessions: {},
    activeTabId: null,
    recentlySeenUrls: mocks.recentlySeenUrls,
  }),
}));
vi.mock("./PreviewChromeRow", () => ({ PreviewChromeRow: () => null }));
vi.mock("./PreviewEmptyState", () => ({ PreviewEmptyState: () => null }));

import { PreviewChromeRow } from "./PreviewChromeRow";
import { ServerBrowserPanel } from "./ServerBrowserPanel";

const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") };
const installation = (state: PreviewServerBrowserInstallation["state"]) => ({
  state,
  stage: null,
  version: "1.0.0",
  error: null,
});
let renderer: ReactTestRenderer | undefined;

const render = () => <ServerBrowserPanel threadRef={threadRef} visible />;
const buttonLabels = () =>
  renderer!.root.findAllByType("button").map((button) => button.props.children);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.open.mockReset().mockResolvedValue({ _tag: "Failure", cause: Cause.fail("offline") });
  mocks.install.mockReset();
  mocks.recentlySeenUrls = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("ServerBrowserPanel installation", () => {
  it("asks before installing and opens the requested URL once installed", async () => {
    mocks.installation = installation("not-installed");
    await act(() => {
      renderer = create(render());
    });
    expect(buttonLabels()).toEqual(["Install browser", "Later"]);

    await act(() =>
      renderer!.root.findByType(PreviewChromeRow).props.onSubmit("http://localhost:3000"),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();

    mocks.installation = installation("installed");
    await act(() => renderer!.update(render()));
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, url: "http://localhost:3000", runtime: "server" },
    });
  });

  it("keeps the URL a cold link click requested and opens it once installed", async () => {
    mocks.installation = installation("not-installed");
    mocks.recentlySeenUrls = ["http://localhost:5173/"];
    await act(() => {
      renderer = create(render());
    });
    expect(renderer!.root.findByType(PreviewChromeRow).props.url).toBe("http://localhost:5173/");
    expect(mocks.open).not.toHaveBeenCalled();

    mocks.installation = installation("installed");
    await act(() => renderer!.update(render()));
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, url: "http://localhost:5173/", runtime: "server" },
    });
  });
});
