import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentId,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  type TerminalCloseInput,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClosedViewStore, type ClosedView } from "./closedViewStore";
import { __setClientSettingsForTests } from "./hooks/useSettings";
import { readThreadPreviewState, resetPreviewStateForTests } from "./previewStateStore";
import { reopenClosedView } from "./reopenClosedView";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "./terminalUiStateStore";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "old-tab",
  navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "freeform", width: 1200, height: 800 },
  profileId: "work",
  updatedAt: "2026-09-22T12:00:00.000Z",
};

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  resetPreviewStateForTests();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
});

describe("reopenClosedView", () => {
  it("shows a hidden panel only while it still has a saved tab", async () => {
    const options = {
      openPreview: vi.fn(),
      closeTerminal: vi.fn(),
      openTerminal: vi.fn(),
      workspace: null,
    };
    const view = { kind: "panel", threadRef } as const satisfies ClosedView;
    expect(await reopenClosedView(view, options)).toBe(false);
    useRightPanelStore.getState().open(threadRef, "diff");
    useRightPanelStore.getState().close(threadRef);
    expect(await reopenClosedView(view, options)).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ isOpen: true, activeSurfaceId: "diff" });
  });

  it("restores saved file and pull request tabs without creating resources", async () => {
    const openPreview = vi.fn();
    const openTerminal = vi.fn();
    const options = {
      openPreview,
      openTerminal,
      closeTerminal: vi.fn(),
      workspace: { cwd: "/repo" },
    };
    expect(
      await reopenClosedView(
        {
          kind: "panel-tab",
          threadRef,
          surface: {
            kind: "file",
            id: "file:src/app.ts",
            relativePath: "src/app.ts",
            revealLine: 18,
            revealRequestId: 1,
          },
        },
        options,
      ),
    ).toBe(true);
    expect(
      await reopenClosedView(
        {
          kind: "panel-tab",
          threadRef,
          surface: {
            kind: "pull-request",
            id: "pull-request:example",
            projectId: "project-1",
            repository: "owner/repo",
            number: 42,
          },
        },
        options,
      ),
    ).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.surfaces.map((surface) => surface.kind)).toEqual(["file", "pull-request"]);
    expect(state.isOpen).toBe(true);
    expect(openPreview).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it("does not reopen workspace tabs without an available project", async () => {
    const options = {
      openPreview: vi.fn(),
      openTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      workspace: null,
    };
    for (const surface of [
      { kind: "files", id: "files" },
      {
        kind: "file",
        id: "file:src/app.ts",
        relativePath: "src/app.ts",
        revealLine: null,
        revealRequestId: 0,
      },
    ] as const) {
      expect(await reopenClosedView({ kind: "panel-tab", threadRef, surface }, options)).toBe(
        false,
      );
    }
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });

  it("recreates a browser tab with saved URL, viewport and profile, then selects its new ID", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success({ ...snapshot, tabId: "new-tab" }));
    const result = await reopenClosedView(
      { kind: "browser", threadRef, snapshot },
      { openPreview, openTerminal: vi.fn(), closeTerminal: vi.fn(), workspace: null },
    );
    expect(result).toBe(true);
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "https://example.com",
        viewport: snapshot.viewport,
        profileId: "work",
      },
    });
    expect(readThreadPreviewState(threadRef).snapshot?.tabId).toBe("new-tab");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
        .activeSurfaceId,
    ).toBe("browser:new-tab");
  });

  it("leaves the panel unchanged when a browser resource fails to reopen", async () => {
    const result = await reopenClosedView(
      { kind: "browser", threadRef, snapshot },
      {
        openPreview: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
        openTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        workspace: null,
      },
    );
    expect(result).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });

  it("opens fresh shells for saved splits and keeps their active position", async () => {
    const openTerminal = vi.fn(
      async (_request: { environmentId: EnvironmentId; input: TerminalOpenInput }) =>
        AsyncResult.success({}),
    );
    const view = {
      kind: "panel-tab",
      threadRef,
      surface: {
        kind: "terminal",
        id: "terminal:term-1",
        resourceId: "term-1",
        terminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-1",
        splitDirection: "vertical",
      },
    } as const satisfies ClosedView;
    const result = await reopenClosedView(view, {
      openPreview: vi.fn(),
      openTerminal,
      closeTerminal: vi.fn(),
      workspace: { cwd: "/repo", worktreePath: "/repo/worktree", env: { FOO: "bar" } },
    });
    expect(result).toBe(true);
    expect(openTerminal).toHaveBeenCalledTimes(2);
    const ids = openTerminal.mock.calls.map(([request]) => request.input.terminalId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id !== "term-1" && id !== "term-2")).toBe(true);
    expect(openTerminal.mock.calls[0]?.[0]).toMatchObject({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        cwd: "/repo",
        worktreePath: "/repo/worktree",
        env: { FOO: "bar" },
      },
    });
    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces[0];
    expect(surface).toMatchObject({
      kind: "terminal",
      terminalIds: ids,
      activeTerminalId: ids[0],
      splitDirection: "vertical",
    });
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ),
    ).toMatchObject({ terminalOpen: false, terminalIds: [] });
  });

  it("reopens a hidden drawer without a new process and starts a blank shell when empty", async () => {
    const terminals = useTerminalUiStateStore.getState();
    terminals.ensureTerminal(threadRef, "existing", { open: true });
    terminals.setTerminalOpen(threadRef, false);
    const openTerminal = vi.fn(async () => AsyncResult.success({}));
    const options = {
      openPreview: vi.fn(),
      openTerminal,
      closeTerminal: vi.fn(),
      workspace: { cwd: "/repo" },
    };
    expect(await reopenClosedView({ kind: "terminal-drawer", threadRef }, options)).toBe(true);
    expect(openTerminal).not.toHaveBeenCalled();
    terminals.closeTerminal(threadRef, "existing");
    expect(await reopenClosedView({ kind: "terminal-drawer", threadRef }, options)).toBe(true);
    expect(openTerminal).toHaveBeenCalledTimes(1);
    const state = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    );
    expect(state.terminalIds).toHaveLength(1);
    expect(state.terminalIds).not.toContain("existing");
    expect(state.terminalOpen).toBe(true);
  });

  it("keeps failed shell opens retryable and does not add a dead terminal ID", async () => {
    const openTerminal = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("offline"))));
    const view = {
      kind: "terminal",
      threadRef,
      terminalId: "term-1",
    } as const satisfies ClosedView;
    const options = {
      openPreview: vi.fn(),
      openTerminal,
      closeTerminal: vi.fn(),
      workspace: { cwd: "/repo" },
    };
    expect(await reopenClosedView(view, options)).toBe(false);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalIds,
    ).toEqual([]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });

  it("reserves the new ID before the server replies so a concurrent open picks another", async () => {
    let reply!: (result: AtomCommandResult<unknown, unknown>) => void;
    const openTerminal = vi.fn(
      () =>
        new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
          reply = resolve;
        }),
    );
    const pending = reopenClosedView(
      { kind: "terminal", threadRef, terminalId: "term-1" },
      { openPreview: vi.fn(), openTerminal, closeTerminal: vi.fn(), workspace: { cwd: "/repo" } },
    );
    const state = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    );
    expect(state.terminalIds).toEqual(["term-2"]);
    expect(state.terminalOpen).toBe(false);
    expect(nextTerminalId(state.terminalIds)).not.toBe("term-2");
    reply(AsyncResult.success({}));
    expect(await pending).toBe(true);
  });

  it("restores a closed split into its surviving panel group", async () => {
    const panels = useRightPanelStore.getState();
    panels.openTerminal(threadRef, "term-1");
    const openTerminal = vi.fn(async () => AsyncResult.success({}));
    expect(
      await reopenClosedView(
        {
          kind: "terminal",
          threadRef,
          terminalId: "term-2",
          panelSurfaceId: "terminal:term-1",
          splitDirection: "vertical",
        },
        { openPreview: vi.fn(), openTerminal, closeTerminal: vi.fn(), workspace: { cwd: "/repo" } },
      ),
    ).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.surfaces).toHaveLength(1);
    expect(state.surfaces[0]).toMatchObject({
      kind: "terminal",
      terminalIds: ["term-1", "term-3"],
      activeTerminalId: "term-3",
      splitDirection: "vertical",
    });
  });

  it("cleans up opened shells if a later split pane fails, leaving history retryable", async () => {
    const results = [
      AsyncResult.success({}),
      AsyncResult.failure(Cause.fail(new Error("offline"))),
    ];
    const openTerminal = vi.fn(
      async (_request: { environmentId: EnvironmentId; input: TerminalOpenInput }) =>
        results.shift()!,
    );
    const closeTerminal = vi.fn(
      async (_request: { environmentId: EnvironmentId; input: TerminalCloseInput }) =>
        AsyncResult.success({}),
    );
    const view = {
      kind: "panel-tab",
      threadRef,
      surface: {
        kind: "terminal",
        id: "terminal:term-1",
        resourceId: "term-1",
        terminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-2",
      },
    } as const satisfies ClosedView;
    expect(
      await reopenClosedView(view, {
        openPreview: vi.fn(),
        openTerminal,
        closeTerminal,
        workspace: { cwd: "/repo" },
      }),
    ).toBe(false);
    expect(closeTerminal).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: openTerminal.mock.calls[0]?.[0]?.input?.terminalId,
        deleteHistory: true,
      },
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a terminal opened during a pending split restore when a later pane fails", async () => {
    let reply!: (result: AtomCommandResult<unknown, unknown>) => void;
    const openTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
            reply = resolve;
          }),
      )
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    const closeTerminal = vi.fn(
      async (_request: { environmentId: EnvironmentId; input: TerminalCloseInput }) =>
        AsyncResult.success({}),
    );
    const view = {
      kind: "panel-tab",
      threadRef,
      surface: {
        kind: "terminal",
        id: "terminal:term-1",
        resourceId: "term-1",
        terminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-1",
      },
    } as const satisfies ClosedView;
    const pending = reopenClosedView(view, {
      openPreview: vi.fn(),
      openTerminal,
      closeTerminal,
      workspace: { cwd: "/repo" },
    });
    const terminals = useTerminalUiStateStore.getState();
    const reserved = selectThreadTerminalUiState(
      terminals.terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds;
    expect(reserved).toEqual(["term-3", "term-4"]);
    const userId = nextTerminalId(reserved);
    terminals.newTerminal(threadRef, userId);
    reply(AsyncResult.success({}));
    expect(await pending).toBe(false);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalIds,
    ).toEqual([userId]);
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeTerminal.mock.calls[0]?.[0].input.terminalId).toBe("term-3");
  });
});
