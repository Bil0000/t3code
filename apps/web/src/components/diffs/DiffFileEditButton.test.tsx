import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { status, file, refresh, readFile, writeFile, blocker, blockOptions, dialogPayload } =
  vi.hoisted(() => ({
    status: {
      data: { refName: "review", pr: { url: "https://github.com/example/repo/pull/1" } },
      isSuccess: true,
      isPending: false,
      error: null as string | null,
    },
    file: { data: { contents: "complete file", truncated: false }, error: null as string | null },
    refresh: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    blockOptions: vi.fn(),
    dialogPayload: { value: {} },
    blocker: { status: "idle", proceed: vi.fn(), reset: vi.fn() },
  }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: readFile }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { refresh } }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => status,
  formatEnvironmentQueryError: () => "Save or read failed",
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    blockOptions(options);
    return blocker;
  },
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: () => null,
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../files/FilePreviewPanel", () => ({
  EditableFileSurface: ({
    contents,
    onContentsChange,
  }: {
    contents: string;
    onContentsChange: (contents: string) => void;
  }) => <textarea value={contents} onChange={(event) => onContentsChange(event.target.value)} />,
}));
vi.mock("../ui/dialog", () => ({
  DialogCreateHandle: () => ({}),
  Dialog: ({ children }: { children: (state: { payload: object }) => ReactNode }) =>
    children({ payload: dialogPayload.value }),
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogTrigger: () => null,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? children : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));

import { Dialog } from "../ui/dialog";
import { DiffFileEditButton, DiffFileEditDialog } from "./DiffFileEditButton";

let renderer: ReactTestRenderer;
const pullRequestUrl = "https://github.com/example/repo/pull/1";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  blocker.status = "idle";
  blocker.proceed.mockReset();
  blocker.reset.mockReset();
  writeFile.mockReset().mockResolvedValue({ _tag: "Success" });
  status.data.pr.url = pullRequestUrl;
  status.isSuccess = true;
  status.error = null;
  file.data.truncated = false;
  file.data.contents = "complete file";
  file.error = null;
  refresh.mockClear();
  readFile
    .mockReset()
    .mockImplementation(async () =>
      file.error ? { _tag: "Failure" } : { _tag: "Success", value: file.data },
    );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function open(url?: string, filePath = "file.ts") {
  dialogPayload.value = {
    environmentId: EnvironmentId.make("test"),
    cwd: "/repo",
    filePath,
    ...(url ? { pullRequestUrl: url } : {}),
  };
  await act(async () => {
    renderer = create(
      <>
        <DiffFileEditDialog />
        <DiffFileEditButton
          environmentId={EnvironmentId.make("test")}
          cwd="/repo"
          filePath={filePath}
        />
      </>,
    );
  });
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(true));
}

it("opens the working file for the checked-out pull request", async () => {
  await open(pullRequestUrl);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(1);
  expect(readFile.mock.calls[0]?.[2]).toMatchObject({ refresh: true });
});

it("waits for the new checkout read before showing cached file contents", async () => {
  let finishRead!: (value: unknown) => void;
  readFile.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
  file.data.contents = "cached branch A";
  await open();
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(renderer.root.findByType("p").children.join("")).toBe("Loading file...");
  file.data.contents = "fresh branch B";
  await act(async () => finishRead({ _tag: "Success", value: file.data }));
  expect(renderer.root.findByType("textarea").props.value).toBe("fresh branch B");
});

it.each(["image.png", "movie.mp4", "audio.mp3"])(
  "does not edit media file %s as text",
  async (path) => {
    await open(undefined, path);
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
    expect(renderer.root.findByType("p").children.join("")).toContain("cannot be edited as text");
  },
);

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
      /Check out|unavailable|too large|failed/,
    );
  },
);

async function edit(contents = "my changes") {
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: contents } }),
  );
}

async function click(label: string) {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === label)!
      .props.onClick(),
  );
}

it.each(["ctrlKey", "metaKey"])(
  "saves only on %s+S and clears the unsaved state",
  async (modifier) => {
    await open();
    await edit();
    expect(writeFile).not.toHaveBeenCalled();
    expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
    expect(renderer.root.findAllByProps({ "aria-label": "Unsaved changes" })).toHaveLength(1);
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key: "s",
      [modifier]: true,
    });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId: "test",
      input: {
        cwd: "/repo",
        relativePath: "file.ts",
        contents: "my changes",
        expectedBranch: "review",
      },
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Unsaved changes" })).toHaveLength(0);
    expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
  },
);

it("keeps edits when closing is cancelled, and discards without writing", async () => {
  await open();
  await edit();
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(false));
  expect(renderer.root.findByType("h2").children.join("")).toBe("Save changes before leaving?");
  await click("Keep editing");
  expect(renderer.root.findByType("textarea").props.value).toBe("my changes");
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(false));
  await click("Discard");
  expect(renderer.root.findByType(Dialog).props.open).toBe(false);
  expect(writeFile).not.toHaveBeenCalled();
});

it("keeps a failed save open and closes after a successful retry", async () => {
  await open();
  await edit();
  writeFile.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(false));
  await click("Save");
  expect(renderer.root.findByType("textarea").props.value).toBe("my changes");
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
    "Save or read failed",
  );
  await click("Save");
  expect(renderer.root.findByType(Dialog).props.open).toBe(false);
});

it("keeps edits made during a save dirty and blocks duplicate saves", async () => {
  await open();
  await edit("first");
  let finishSave!: (value: unknown) => void;
  writeFile.mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)));
  await click("Save");
  await edit("second");
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(false));
  await click("Saving...");
  expect(writeFile).toHaveBeenCalledOnce();
  await act(async () => finishSave({ _tag: "Success" }));
  expect(renderer.root.findByType("textarea").props.value).toBe("second");
  expect(renderer.root.findByType(Dialog).props.open).toBe(true);
  await click("Save");
  expect(writeFile.mock.lastCall?.[0].input.contents).toBe("second");
  expect(renderer.root.findByType(Dialog).props.open).toBe(false);
});

it("stops treating a reverted edit as unsaved", async () => {
  await open();
  await edit();
  await edit("complete file");
  await act(async () => renderer.root.findByType(Dialog).props.onOpenChange(false));
  expect(renderer.root.findByType(Dialog).props.open).toBe(false);
  expect(writeFile).not.toHaveBeenCalled();
});

it("guards navigation until the draft is saved", async () => {
  await open();
  blocker.status = "blocked";
  await edit();
  expect(renderer.root.findByType("h2").children.join("")).toBe("Save changes before leaving?");
  expect(blocker.proceed).not.toHaveBeenCalled();
  await click("Save");
  expect(blocker.proceed).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
});

it("closes the editor when discarding a draft to navigate", async () => {
  await open();
  blocker.status = "blocked";
  await edit();
  await click("Discard");
  expect(blocker.proceed).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(writeFile).not.toHaveBeenCalled();
});

it.each([
  "https://github.com/example/repo/pull/1",
  "https://gitlab.com/example/repo/-/merge_requests/1",
  "https://bitbucket.org/example/repo/pull-requests/1",
])("edits the checked-out review at %s", async (url) => {
  status.data.pr.url = url;
  await open(url);
  await edit();
  await click("Save");
  expect(writeFile.mock.lastCall?.[0].input.expectedBranch).toBe("review");
});

it("keeps the draft when its diff row is removed from the view", async () => {
  await open();
  await edit();
  await act(async () =>
    renderer.update(
      <>
        <DiffFileEditDialog />
      </>,
    ),
  );
  expect(renderer.root.findByType("textarea").props.value).toBe("my changes");
  expect(writeFile).not.toHaveBeenCalled();
  await click("Save");
  expect(writeFile.mock.lastCall?.[0].input.contents).toBe("my changes");
});
