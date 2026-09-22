import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  params: {} as Record<string, string>,
  paletteOpen: false,
  editable: false,
  shellStatus: "live",
  catalog: { isReady: true, entries: new Map([["remote", {}]]) },
  missing: new Set<string>(),
  draft: null as {
    environmentId: string;
    threadId: string;
    projectId: string;
    worktreePath: string | null;
  } | null,
  navigate: vi.fn(),
  openPreview: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  setShortcuts: vi.fn(async () => undefined),
  toast: vi.fn(),
}));

vi.mock("./preview/openPreviewSession", () => ({ openPreviewSession: state.openPreview }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.keybindings }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.params,
}));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: state.openPreview } }));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { open: state.openTerminal, close: state.closeTerminal },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => ({}) } }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === "catalog" ? state.catalog : { status: state.shellStatus }),
  },
}));
vi.mock("../state/entities", () => ({
  readThreadShell: (ref: ScopedThreadRef) =>
    state.missing.has(ref.threadId) ? null : { projectId: "project-1", worktreePath: "/work/tree" },
  readProject: () => ({ workspaceRoot: "/work/project" }),
}));
vi.mock("../composerDraftStore", () => {
  const store = {
    getDraftSession: () => state.draft,
    getDraftThreadByRef: (ref: ScopedThreadRef) =>
      state.draft?.threadId === ref.threadId ? state.draft : null,
    getDraftIdByRef: () => "draft-1",
  };
  return {
    useComposerDraftStore: Object.assign(
      (select: (value: typeof store) => unknown) => select(store),
      { getState: () => store },
    ),
  };
});
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => state.paletteOpen }));
vi.mock("../lib/editableFocus", () => ({ isEditableFocused: () => state.editable }));
vi.mock("../lib/previewFocus", () => ({ isPreviewFocused: () => false }));
vi.mock("../lib/terminalFocus", () => ({ isTerminalFocused: () => false }));
vi.mock("../modelPickerVisibility", () => ({ isModelPickerOpen: () => false }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));

import { useClosedViewStore } from "../closedViewStore";
import {
  PULL_REQUESTS_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";

const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
let renderer: ReactTestRenderer | undefined;
let menuAction: ((action: string) => void) | undefined;

async function render() {
  await act(() => {
    renderer = create(<ReopenClosedViewShortcut />);
  });
}

function press(overrides: Record<string, unknown> = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "T",
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    repeat: false,
    ...overrides,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    params: {},
    paletteOpen: false,
    editable: false,
    shellStatus: "live",
    catalog: { isReady: true, entries: new Map([["remote", {}]]) },
    missing: new Set(),
    draft: null,
  });
  state.navigate.mockResolvedValue(undefined);
  state.openTerminal.mockResolvedValue(AsyncResult.success({}));
  state.closeTerminal.mockResolvedValue(AsyncResult.success({}));
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        preview: { setReopenClosedShortcuts: state.setShortcuts },
        onMenuAction: (listener: typeof menuAction) => {
          menuAction = listener;
          return () => {
            menuAction = undefined;
          };
        },
      },
    }),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("root reopen shortcut", () => {
  it("restores a tab from settings to its owning remote thread", async () => {
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await render();
    await act(() => {
      expect(press().defaultPrevented).toBe(true);
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(state.navigate).toHaveBeenCalledWith({ to: "/$environmentId/$threadId", params: ref });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("leaves native shortcuts alone without history or while the palette is open", async () => {
    await render();
    expect(press().defaultPrevented).toBe(false);
    await act(() => {
      useClosedViewStore.getState().remember({ kind: "terminal-drawer", threadRef: ref });
    });
    state.paletteOpen = true;
    expect(press().defaultPrevented).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
  });

  it("honors custom chords and when conditions, and consumes repeats without restoring", async () => {
    state.keybindings = [
      {
        command: "rightPanel.reopenClosed",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        whenAst: { type: "not", node: { type: "identifier", name: "editableFocus" } },
      },
    ];
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    await render();
    expect(press().defaultPrevented).toBe(false);
    state.editable = true;
    expect(press({ key: "r", shiftKey: false }).defaultPrevented).toBe(false);
    state.editable = false;
    await act(() => {
      expect(press({ key: "r", shiftKey: false, repeat: true }).defaultPrevented).toBe(true);
    });
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
    await act(() => {
      press({ key: "r", shiftKey: false });
    });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("serializes deliberate presses while a terminal restore waits for RPC", async () => {
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    useClosedViewStore
      .getState()
      .remember({ kind: "terminal", threadRef: ref, terminalId: "closed-1" });
    let finish!: (value: ReturnType<typeof AsyncResult.success>) => void;
    state.openTerminal.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(() => {
      press();
      press();
    });
    expect(state.openTerminal).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(useClosedViewStore.getState().entries).toHaveLength(2);
    await act(() => {
      finish(AsyncResult.success({}));
    });
    expect(state.openTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "remote",
        input: expect.objectContaining({
          cwd: "/work/tree",
          worktreePath: "/work/tree",
          env: expect.any(Object),
        }),
      }),
    );
    expect(state.navigate).toHaveBeenCalledTimes(2);
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("keeps failed restores available for retry", async () => {
    const id = useClosedViewStore
      .getState()
      .remember({ kind: "terminal", threadRef: ref, terminalId: "closed-1" });
    state.openTerminal.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await render();
    await act(() => {
      press();
    });
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([id]);
    expect(state.navigate).not.toHaveBeenCalled();
    state.openTerminal.mockResolvedValue(AsyncResult.success({}));
    await act(() => {
      press();
    });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("retains missing live-shell threads and skips already-open tabs to restore the next view", async () => {
    const panels = useRightPanelStore.getState();
    panels.open(ref, "files");
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    const missing = { ...ref, threadId: "archived-or-deleted" } as ScopedThreadRef;
    state.missing.add(missing.threadId);
    const missingId = useClosedViewStore
      .getState()
      .remember({ kind: "terminal-drawer", threadRef: missing });
    await render();
    await act(() => {
      press();
    });
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([missingId]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "only drops a removed environment when the catalog is ready (%s)",
    async (isReady) => {
      state.catalog.isReady = isReady;
      state.shellStatus = "cached";
      const olderId = useClosedViewStore
        .getState()
        .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
      const removedId = useClosedViewStore.getState().remember({
        kind: "panel-tab",
        threadRef: { ...ref, environmentId: "removed" } as ScopedThreadRef,
        surface: { kind: "diff", id: "diff" },
      });
      await render();
      await act(() => {
        press();
      });
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual(
        isReady ? [] : [removedId, olderId],
      );
      expect(state.navigate).toHaveBeenCalledTimes(isReady ? 1 : 0);
      if (isReady)
        expect(state.navigate).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: ref,
        });
    },
  );

  it("does not treat a disconnected environment as proof that its thread was deleted", async () => {
    state.shellStatus = "cached";
    state.missing.add(ref.threadId);
    const id = useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await render();
    await act(() => {
      press();
    });
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([id]);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("returns local drafts to the draft route", async () => {
    state.missing.add(ref.threadId);
    state.draft = { ...ref, projectId: "project-1", worktreePath: null };
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    await render();
    await act(() => {
      press();
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: "draft-1" },
    });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("restores global PR selection through the desktop menu without losing list filters", async () => {
    useClosedViewStore.getState().remember({
      kind: "panel-tab",
      threadRef: PULL_REQUESTS_PANEL_REF,
      surface: {
        kind: "pull-request",
        id: "pull-request:example",
        repository: "owner/repo",
        number: 42,
        projectId: "project-1",
        environmentId: "remote",
        host: "github.example.com",
      },
    });
    await render();
    expect(state.setShortcuts).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: "t", shiftKey: true })]),
    );
    await act(() => {
      menuAction?.("reopen-closed");
    });
    const navigation = state.navigate.mock.calls[0]![0];
    expect(navigation.to).toBe("/pull-requests");
    expect(
      navigation.search({
        involvement: "reviewing",
        state: "open",
        q: "mine",
        host: "filter.example.com",
        selectedHost: "old",
        selectedEnvironmentId: "old",
      }),
    ).toEqual({
      involvement: "reviewing",
      state: "open",
      q: "mine",
      host: "filter.example.com",
      repository: "owner/repo",
      number: 42,
      selectedProjectId: "project-1",
      selectedHost: "github.example.com",
      selectedEnvironmentId: "remote",
    });
    expect(useClosedViewStore.getState().entries).toEqual([]);
    expect(state.setShortcuts).toHaveBeenLastCalledWith([]);
  });
});
