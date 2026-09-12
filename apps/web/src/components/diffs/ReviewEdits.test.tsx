import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { read, write, refresh, blockOptions, blocker, toast } = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  blockOptions: vi.fn(),
  toast: vi.fn(),
  blocker: { status: "idle", proceed: vi.fn(), reset: vi.fn() },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: read }));
vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: Object.assign(AtomRegistry.make(), { refresh }) };
});
vi.mock("~/state/vcs", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const status = Atom.make(
    AsyncResult.success({ refName: "review", pr: { url: "" } }, { waiting: true }),
  );
  return { vcsEnvironment: { status: () => status } };
});
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => write }));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Request failed" }));
vi.mock("../files/projectFilesQueryState", () => ({ getProjectFileQueryAtom: () => "file" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    blockOptions(options);
    return blocker;
  },
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? children : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => children,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { vcsEnvironment } from "~/state/vcs";
import { readReviewDraft, reviewEditKey, ReviewEditsProvider, useReviewEdits } from "./ReviewEdits";

const target = { environmentId: EnvironmentId.make("test"), cwd: "/repo", filePath: "file.ts" };
const savedDraft = {
  ...target,
  contents: "saved",
  savedContents: "saved",
  expectedBranch: "review",
};
const key = reviewEditKey(target);
let renderer: ReactTestRenderer;
let edits: NonNullable<ReturnType<typeof useReviewEdits>>;
function Probe() {
  const value = useReviewEdits()!;
  useEffect(() => {
    edits = value;
  }, [value]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  blocker.status = "idle";
  blocker.proceed.mockReset().mockImplementation(() => {
    blocker.status = "idle";
  });
  blocker.reset.mockReset().mockImplementation(() => {
    blocker.status = "idle";
  });
  blockOptions.mockClear();
  write.mockReset().mockResolvedValue({ _tag: "Success" });
  refresh.mockClear();
  toast.mockClear();
  setStatus("https://github.com/example/repo/pull/1");
  read
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { contents: "fresh", truncated: false } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    );
  });
  await act(async () => {
    edits.begin(savedDraft);
    edits.focus(key);
  });
}
async function change(contents = "changed") {
  await act(async () => edits.change(key, contents));
}
async function save(modifier = "ctrlKey") {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "s",
    [modifier]: true,
  });
  await act(async () => window.dispatchEvent(event));
  return event;
}
async function click(label: string) {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === label)!
      .props.onClick(),
  );
}
async function blockNavigation() {
  blocker.status = "blocked";
  await act(async () =>
    renderer.update(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    ),
  );
}

function setStatus(url: string) {
  appAtomRegistry.set(
    vcsEnvironment.status({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    }) as never,
    AsyncResult.success({ refName: "review", pr: { url } }, { waiting: true }),
  );
}
it("reads working contents while the status stream is still waiting for updates", async () => {
  expect(await readReviewDraft(target)).toMatchObject({
    contents: "fresh",
    savedContents: "fresh",
    expectedBranch: "review",
  });
  expect(read.mock.calls.map((call) => [call[1], call[2].refresh])).toEqual([["file", true]]);
});
it.each([
  "https://github.com/example/repo/pull/1",
  "https://gitlab.com/example/repo/-/merge_requests/1",
  "https://bitbucket.org/example/repo/pull-requests/1",
])("checks the local checkout for %s", async (url) => {
  setStatus(url);
  expect(await readReviewDraft({ ...target, pullRequestUrl: url })).toMatchObject({
    expectedBranch: "review",
  });
});
it("refuses a different checked-out PR", async () => {
  await expect(
    readReviewDraft({ ...target, pullRequestUrl: "https://github.com/example/repo/pull/2" }),
  ).rejects.toThrow("Check out");
  expect(read).not.toHaveBeenCalled();
});
it.each(["failure", "truncated"])("does not edit an incomplete read: %s", async (reason) => {
  read.mockResolvedValueOnce(
    reason === "failure"
      ? { _tag: "Failure" }
      : { _tag: "Success", value: { contents: "partial", truncated: true } },
  );
  await expect(readReviewDraft(target)).rejects.toThrow();
});
it.each(["ctrlKey", "metaKey"])("saves only on %s+S", async (modifier) => {
  await mount();
  await change();
  expect(write).not.toHaveBeenCalled();
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
  expect((await save(modifier)).defaultPrevented).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith({
    environmentId: "test",
    input: { cwd: "/repo", relativePath: "file.ts", contents: "changed", expectedBranch: "review" },
  });
  expect(edits.drafts.get(key)?.savedContents).toBe("changed");
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
});
it("keeps failed saves dirty and permits a retry", async () => {
  await mount();
  await change();
  write.mockResolvedValueOnce({ _tag: "Failure" });
  await save();
  expect(edits.drafts.get(key)).toMatchObject({ contents: "changed", savedContents: "saved" });
  expect(toast).toHaveBeenCalledOnce();
  await save();
  expect(edits.drafts.get(key)?.savedContents).toBe("changed");
});
it("retains newer edits made while saving and blocks duplicate writes", async () => {
  await mount();
  await change("first");
  let finish!: (value: unknown) => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await save();
  await change("second");
  await save();
  expect(write).toHaveBeenCalledOnce();
  await act(async () => finish({ _tag: "Success" }));
  expect(edits.drafts.get(key)).toMatchObject({ contents: "second", savedContents: "first" });
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
});
it("preserves dirty drafts when a review surface unmounts", async () => {
  await mount();
  await change();
  await act(async () => renderer.update(<ReviewEditsProvider>{null}</ReviewEditsProvider>));
  await act(async () =>
    renderer.update(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    ),
  );
  await act(async () => edits.begin(savedDraft));
  expect(edits.drafts.get(key)?.contents).toBe("changed");
});
it("does not capture the save shortcut after focus leaves the review editor", async () => {
  await mount();
  await change();
  await act(async () => edits.focus(null));
  expect((await save()).defaultPrevented).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
it("keeps edits on cancelled navigation and discards without writing", async () => {
  await mount();
  await change();
  await blockNavigation();
  await click("Keep editing");
  expect(edits.drafts.get(key)?.contents).toBe("changed");
  await blockNavigation();
  await click("Discard");
  expect(edits.drafts.size).toBe(0);
  expect(write).not.toHaveBeenCalled();
  expect(blocker.proceed).toHaveBeenCalledOnce();
});
it("saves all dirty files before allowing navigation", async () => {
  await mount();
  await change();
  await act(async () => {
    edits.begin({ ...savedDraft, filePath: "other.ts" });
    edits.change(reviewEditKey({ ...target, filePath: "other.ts" }), "other change");
  });
  await blockNavigation();
  await click("Save");
  expect(write.mock.calls.map(([request]) => request.input.relativePath)).toEqual([
    "file.ts",
    "other.ts",
  ]);
  expect(blocker.proceed).toHaveBeenCalledOnce();
  expect(edits.drafts.size).toBe(0);
});
