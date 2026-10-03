import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ChatAttachmentId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, markPromotedDraftThreadByRef, useComposerDraftStore } from "~/composerDraftStore";
import { useScratchProject } from "./useScratchProject";

const mocks = vi.hoisted(() => ({
  ensureScratch: vi.fn(),
  waitForProject: vi.fn(),
  toast: vi.fn(),
  environments: [
    {
      environmentId: "local",
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: "/local/scratch" },
    },
    {
      environmentId: "remote",
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: "/remote/scratch" },
    },
    {
      environmentId: "other",
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: "/other/scratch" },
    },
    {
      environmentId: "offline",
      connection: { phase: "offline" },
      serverConfig: { scratchWorkspaceRoot: "/offline/scratch" },
    },
    { environmentId: "unsupported", connection: { phase: "connected" }, serverConfig: {} },
  ],
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (environmentId: EnvironmentId) =>
      mocks.environments.find((entry) => entry.environmentId === environmentId),
  },
}));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: { presentationAtom: (environmentId: EnvironmentId) => environmentId },
}));
vi.mock("~/state/entities", () => ({ waitForProject: mocks.waitForProject }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { ensureScratch: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.ensureScratch }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: mocks.toast },
}));

const draftId = DraftId.make("scratch-draft");
const remote = EnvironmentId.make("remote");
let renderer: ReactTestRenderer;
let scratch: ReturnType<typeof useScratchProject>;

function Probe({ id = draftId }: { id?: DraftId }) {
  const value = useScratchProject(id);
  useLayoutEffect(() => {
    scratch = value;
  });
  return null;
}

function project(environmentId = remote) {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}-scratch`),
    workspaceRoot: `/${environmentId}/scratch`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.environments[0]!.connection.phase = "connected";
  mocks.environments[1]!.connection.phase = "connected";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {},
    draftsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(
    "scratch",
    scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("local-scratch")),
    draftId,
  );
  store.setPrompt(draftId, "Keep working while my Mac is closed");
  mocks.ensureScratch.mockResolvedValue({ _tag: "Success", value: { projectId: project().id } });
  mocks.waitForProject.mockResolvedValue(project());
  act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("scratch draft connection", () => {
  it("creates the remote scratch project before retargeting the same draft and keeping its text", async () => {
    await act(async () => {
      await scratch.moveScratchDraft(remote);
    });

    expect(mocks.ensureScratch).toHaveBeenCalledWith({ environmentId: remote, input: {} });
    expect(mocks.waitForProject).toHaveBeenCalledWith(scopeProjectRef(remote, project().id));
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: remote,
      projectId: project().id,
      environmentSelection: "manual",
      envMode: "local",
      worktreePath: null,
      branch: null,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Keep working while my Mac is closed",
    );
    expect(scratch.isMovingScratchDraft).toBe(false);
    expect(
      useComposerDraftStore.getState().getDraftSessionByLogicalProjectKey("scratch"),
    ).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftSessionByLogicalProjectKey("remote:/remote/scratch")
        ?.draftId,
    ).toBe(draftId);
  });

  it.each(["offline", "unsupported", "local"])("does not move to %s", async (environmentId) => {
    await act(async () => {
      await scratch.moveScratchDraft(EnvironmentId.make(environmentId));
    });
    expect(mocks.ensureScratch).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
  });

  it("leaves the draft on its original machine when the project does not reach the store", async () => {
    mocks.waitForProject.mockRejectedValue(new Error("Connection lost"));
    await act(async () => {
      await scratch.moveScratchDraft(remote);
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(scratch.isMovingScratchDraft).toBe(false);
  });

  it("keeps the draft on its original machine when the destination disconnects before its cached project arrives", async () => {
    let complete!: (value: ReturnType<typeof project>) => void;
    mocks.waitForProject.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let moving!: Promise<void>;
    await act(async () => {
      moving = scratch.moveScratchDraft(remote);
    });
    mocks.environments = mocks.environments.map((entry) =>
      entry.environmentId === remote ? { ...entry, connection: { phase: "offline" } } : entry,
    );
    act(() => renderer.update(<Probe />));
    await act(async () => {
      complete(project());
      await moving;
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Keep working while my Mac is closed",
    );
    expect(scratch.isMovingScratchDraft).toBe(false);
  });

  it("keeps the old target and clears the pending state when the server rejects scratch creation", async () => {
    mocks.ensureScratch.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Not available")),
    });
    await act(async () => {
      await scratch.moveScratchDraft(remote);
    });
    expect(mocks.waitForProject).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    expect(scratch.isMovingScratchDraft).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Not available" }),
    );
  });

  it("does not move a draft that has already started", async () => {
    const draft = useComposerDraftStore.getState().getDraftThread(draftId)!;
    markPromotedDraftThreadByRef({ environmentId: draft.environmentId, threadId: draft.threadId });
    await act(async () => {
      await scratch.moveScratchDraft(remote);
    });
    expect(mocks.ensureScratch).not.toHaveBeenCalled();
  });

  it("waits for the project and ignores a switch after the draft target changes", async () => {
    let complete!: (value: ReturnType<typeof project>) => void;
    mocks.waitForProject.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let moving!: Promise<void>;
    await act(async () => {
      moving = scratch.moveScratchDraft(remote);
    });
    expect(scratch.isMovingScratchDraft).toBe(true);
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(EnvironmentId.make("other"), ProjectId.make("real-project")),
    });
    await act(async () => {
      complete(project());
      await moving;
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.projectId).toBe(
      "real-project",
    );
    expect(scratch.isMovingScratchDraft).toBe(false);
  });

  it("keeps attachments added during a pending switch on their original machine", async () => {
    let complete!: (value: ReturnType<typeof project>) => void;
    mocks.waitForProject.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let moving!: Promise<void>;
    await act(async () => {
      moving = scratch.moveScratchDraft(remote);
    });
    useComposerDraftStore.getState().addFiles(draftId, [
      {
        id: ChatAttachmentId.make("note"),
        type: "file",
        name: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        file: null,
        uploadedAttachmentId: "fake-upload",
        uploadEnvironmentId: EnvironmentId.make("local"),
      },
    ]);
    await act(async () => {
      complete(project());
      await moving;
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Keep attachments on this machine" }),
    );
    expect(scratch.isMovingScratchDraft).toBe(false);
  });

  it("ignores an older switch that completes after a newer connection choice", async () => {
    let complete!: (value: ReturnType<typeof project>) => void;
    mocks.waitForProject.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let moving!: Promise<void>;
    await act(async () => {
      moving = scratch.moveScratchDraft(remote);
    });
    mocks.waitForProject.mockResolvedValue(project(EnvironmentId.make("other")));
    await act(async () => {
      await scratch.moveScratchDraft(EnvironmentId.make("other"));
    });
    await act(async () => {
      complete(project());
      await moving;
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("other");
  });

  it.each(["connected", "offline"])(
    "cancels a pending switch when the %s original machine is selected again",
    async (phase) => {
      let complete!: (value: ReturnType<typeof project>) => void;
      mocks.waitForProject.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      let moving!: Promise<void>;
      await act(async () => {
        moving = scratch.moveScratchDraft(remote);
      });
      mocks.environments[0]!.connection.phase = phase;
      await act(async () => {
        await scratch.moveScratchDraft(EnvironmentId.make("local"));
      });
      expect(scratch.isMovingScratchDraft).toBe(false);
      await act(async () => {
        complete(project());
        await moving;
      });
      expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    },
  );

  it("does not retarget a draft after navigating to another draft", async () => {
    let complete!: (value: ReturnType<typeof project>) => void;
    mocks.waitForProject.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let moving!: Promise<void>;
    await act(async () => {
      moving = scratch.moveScratchDraft(remote);
    });
    act(() => renderer.update(<Probe id={DraftId.make("another-draft")} />));
    act(() => renderer.update(<Probe />));
    expect(scratch.isMovingScratchDraft).toBe(false);
    await act(async () => {
      complete(project());
      await moving;
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.environmentId).toBe("local");
    expect(scratch.isMovingScratchDraft).toBe(false);
  });
});
