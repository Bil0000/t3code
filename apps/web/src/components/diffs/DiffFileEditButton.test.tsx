import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { status, file, refresh } = vi.hoisted(() => ({
  status: {
    data: { refName: "review", pr: { url: "https://github.com/example/repo/pull/1" } },
    isSuccess: true,
    isPending: false,
    error: null as string | null,
  },
  file: { data: { contents: "complete file", truncated: false }, error: null as string | null },
  refresh: vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => status }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({ ...file, refresh }),
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../files/FilePreviewPanel", () => ({
  EditableFileSurface: ({ contents }: { contents: string }) => <textarea defaultValue={contents} />,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogTrigger: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));

import { Dialog } from "../ui/dialog";
import { DiffFileEditButton } from "./DiffFileEditButton";

let renderer: ReactTestRenderer;
const pullRequestUrl = "https://github.com/example/repo/pull/1";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status.data.pr.url = pullRequestUrl;
  status.isSuccess = true;
  status.error = null;
  file.data.truncated = false;
  file.error = null;
  refresh.mockClear();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function open(url?: string, filePath = "file.ts") {
  await act(async () => {
    renderer = create(
      <DiffFileEditButton
        environmentId={EnvironmentId.make("test")}
        cwd="/repo"
        filePath={filePath}
        {...(url ? { pullRequestUrl: url } : {})}
      />,
    );
  });
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(true));
}

it("opens the working file for the checked-out pull request", async () => {
  await open(pullRequestUrl);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(1);
  expect(refresh).toHaveBeenCalledOnce();
});

it("does not open media files in the text editor", async () => {
  await open(undefined, "image.png");
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(renderer.root.findByType("p").children.join("")).toContain("cannot be edited as text");
});

it("does not require a pull request for local edits", async () => {
  status.data.pr.url = "";
  await open();
  expect(renderer.root.findAllByType("textarea")).toHaveLength(1);
});

it.each(["other branch", "failed status", "truncated file", "read error"])(
  "blocks editing with %s",
  async (reason) => {
    if (reason === "other branch") status.data.pr.url = `${pullRequestUrl}0`;
    if (reason === "failed status") {
      status.isSuccess = false;
      status.error = "Status unavailable";
    }
    if (reason === "truncated file") file.data.truncated = true;
    if (reason === "read error") file.error = "File unavailable";
    await open(pullRequestUrl);
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
    expect(renderer.root.findByType("p").children.join("")).toMatch(
      /Check out|unavailable|too large/,
    );
  },
);
