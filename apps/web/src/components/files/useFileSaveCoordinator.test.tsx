import { EnvironmentId, ProjectWriteFileError } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, clearFile, optimisticFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  clearFile: vi.fn(),
  optimisticFile: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: confirmFile,
  clearProjectFileQueryData: clearFile,
  getOptimisticProjectFileQueryData: optimisticFile,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
let renderer: ReactTestRenderer | null;

function ChangeSource(_props: { onChange: (contents: string) => void }) {
  return null;
}

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  return <ChangeSource onChange={(contents) => coordinator.change(contents)} />;
}

function mount(props: Parameters<typeof useFileSaveCoordinator>[0] = defaultProps) {
  act(() => {
    renderer = create(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    );
  });
}

function changeHandler(): (contents: string) => void {
  return renderer!.root.findByType(ChangeSource).props.onChange;
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  clearFile.mockReset();
  optimisticFile.mockReset();
  onPendingChange.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it.each([
    ["pending edit", "checkout_changed", false],
    ["newer edit", "checkout_changed", false],
    ["pending edit", "operation_failed", false],
    ["pending edit", "checkout_changed", true],
  ] as const)(
    "rejects a delayed save with cached %s and %s (new draft: %s)",
    async (cached, failure, newDraft) => {
      let branch = "review";
      const onSaveError = vi.fn();
      const saved: string[] = [];
      let cachedFile: { contents: string } | null = { contents: cached };
      optimisticFile.mockImplementation(() => cachedFile);
      clearFile.mockImplementation(() => {
        cachedFile = null;
      });
      writeFile.mockImplementation(async ({ input }) => {
        if (newDraft) cachedFile = { contents: cached };
        if (input.expectedBranch !== branch)
          return AsyncResult.failure(
            Cause.fail(
              new ProjectWriteFileError({
                cwd: defaultProps.cwd,
                relativePath: defaultProps.relativePath,
                failure,
                message: "Save failed",
              }),
            ),
          );
        saved.push(input.contents);
        return AsyncResult.success(undefined);
      });
      mount({ ...defaultProps, expectedBranch: branch, onSaveError });
      changeHandler()("pending edit");
      branch = "other";
      await vi.advanceTimersByTimeAsync(500);
      expect(writeFile.mock.calls[0]![0].input.expectedBranch).toBe("review");
      expect(saved).toEqual([]);
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
      expect(onSaveError).toHaveBeenCalledWith("Save failed");
      expect(cachedFile?.contents ?? null).toBe(
        cached === "pending edit" && failure === "checkout_changed" && !newDraft ? null : cached,
      );
    },
  );

  it("persists editor model changes after StrictMode setup replay", async () => {
    mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await act(async () => renderer!.unmount());
    renderer = null;
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...nextProps} />
        </StrictMode>,
      ),
    );
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    mount();
    const retiredChange = changeHandler();
    await act(async () => renderer!.unmount());
    renderer = null;
    mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
