import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  composerContextImportsAtom,
  composerDraftsAtom,
  resetComposerDraftsLoadState,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import * as DateTime from "effect/DateTime";

const refreshProviders = vi.hoisted(() => vi.fn());
const threadImport = vi.hoisted(() => ({
  load: vi.fn(),
  write: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    { environmentId: "test-environment", environmentLabel: "Local", connectionState: "connected" },
    { environmentId: "remote", environmentLabel: "Devbox", connectionState: "connected" },
  ],
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { threadTranscript: "threadTranscript" },
}));
vi.mock("expo-file-system", () => ({
  Directory: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = parent.uri + "/" + name;
    }
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    uri: string;
    exists = true;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = typeof parent === "string" ? parent : parent.uri + "/" + name;
    }
    delete() {
      threadImport.cleanup(this.uri);
    }
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: threadImport.write }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id", randomHex: () => "0000" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "threadTranscript" ? threadImport.load : refreshProviders,
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("workspace command discovery retry", () => {
  let root: Root;
  const environmentId = EnvironmentId.make("test-environment");
  const instanceId = ProviderInstanceId.make("claude");
  const provider = {
    instanceId,
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: [
      {
        cwd: "/project-a",
        checkedAt: "2026-01-01T00:00:00.000Z",
        slashCommandsPending: true,
        slashCommands: [{ name: "compact" }],
        skills: [],
      },
    ],
  } satisfies ServerProvider;

  function Probe({ cwd, status = provider }: { cwd: string; status?: ServerProvider }) {
    useComposerCommandMenu({
      draftMessage: "/project",
      ownerKey: null,
      environmentId,
      projectCwd: cwd,
      selectedProviderStatus: status,
      hasThread: false,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    refreshProviders.mockReset();
    threadImport.load.mockReset();
    threadImport.write.mockReset();
    threadImport.cleanup.mockReset();
    appAtomRegistry.set(composerDraftsAtom, {});
    appAtomRegistry.set(composerContextImportsAtom, {});
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    resetComposerDraftsLoadState();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries partial commands after the cooldown without editing the draft", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: [{ ...provider.workspaceSnapshots[0], slashCommandsPending: false }],
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [provider] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-a" },
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it.each(["pi", "acpRegistry"])(
    "does not poll a healthy %s workspace without discovery",
    async (driver) => {
      const unsupported = {
        ...provider,
        driver: ProviderDriverKind.make(driver),
        workspaceSnapshots: [],
      };
      refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [unsupported] } });
      await act(async () => {
        root.render(createElement(Probe, { cwd: "/project-a", status: unsupported }));
      });
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("arms the remaining cooldown when a concurrent scan publishes partial commands", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [missing] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: provider }));
    });
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("does not retry when a concurrent scan publishes a complete workspace", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [missing] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: recovered }));
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a rejected refresh while published discovery remains pending", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockRejectedValueOnce(new Error("Connection lost"));
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("cancels the old workspace retry and does not duplicate an in-flight request", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    refreshProviders.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-b" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-b" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry when the composer unmounts", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(async () => {
      root.unmount();
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "finish",
    "edit",
    "draft switch",
    "environment switch",
    "unmount",
    "unmount during write",
    "full draft",
    "unsupported files",
  ])("imports a remote mention with correct draft ownership after %s", async (change) => {
    let resolve!: (value: {
      _tag: "Success";
      value: { threadId: ThreadId; title: string; updatedAt: DateTime.Utc; items: [] };
    }) => void;
    threadImport.load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const write = Promise.withResolvers<void>();
    if (change === "unmount during write") threadImport.write.mockReturnValue(write.promise);
    setComposerDraftText("draft", "Look at @Login");
    if (change === "full draft")
      appAtomRegistry.set(composerDraftsAtom, {
        draft: {
          text: "Look at @Login",
          attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
            id: `file-${index}`,
            type: "file" as const,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            fileUri: `file:///notes-${index}.txt`,
          })),
        },
      });
    let menu!: ReturnType<typeof useComposerCommandMenu>;
    function MentionProbe({
      owner = "draft",
      env = environmentId,
    }: {
      owner?: string;
      env?: EnvironmentId;
    }) {
      const composerMenu = useComposerCommandMenu({
        draftMessage: getComposerDraftSnapshot(owner).text,
        ownerKey: owner,
        environmentId: env,
        threadShells: [
          {
            environmentId: EnvironmentId.make("remote"),
            id: ThreadId.make("thread"),
            title: "Login flow",
            updatedAt: "2026-10-20T00:00:00Z",
            archivedAt: null,
          },
        ],
        projectCwd: null,
        selectedProviderStatus: null,
        hasThread: true,
        hasCompactableConversation: false,
        fileAttachmentMaxBytes: change === "unsupported files" ? null : 4096,
        onChangeDraftMessage: (value) => {
          setComposerDraftText(owner, value);
        },
      });
      useLayoutEffect(() => {
        menu = composerMenu;
      });
      return null;
    }
    act(() => root.render(createElement(MentionProbe)));
    const item = menu.items[0]!;
    expect(item.description).toBe("Thread · Devbox");
    act(() => menu.onSelect(item));
    if (change === "full draft" || change === "unsupported files") {
      expect(threadImport.load).not.toHaveBeenCalled();
      expect(getComposerDraftSnapshot("draft").text).toBe("Look at @Login");
      expect(appAtomRegistry.get(composerContextImportsAtom)).toEqual({});
      return;
    }
    expect(getComposerDraftSnapshot("draft").text).toBe("Look at ");
    expect(appAtomRegistry.get(composerContextImportsAtom).draft).toBe(true);
    if (change === "unmount") act(() => root.unmount());
    else if (change === "draft switch" || change === "environment switch") {
      act(() =>
        root.render(
          createElement(
            MentionProbe,
            change === "draft switch"
              ? { owner: "other-draft" }
              : { env: EnvironmentId.make("other") },
          ),
        ),
      );
      act(() => root.render(createElement(MentionProbe)));
    } else if (change === "edit") {
      setComposerDraftText("draft", "I typed more while loading");
      act(() => root.render(createElement(MentionProbe)));
    }
    await act(async () =>
      resolve({
        _tag: "Success",
        value: {
          threadId: ThreadId.make("thread"),
          title: "Login flow",
          updatedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
          items: [],
        },
      }),
    );
    if (change === "unmount during write") {
      act(() => root.unmount());
      await act(async () => write.resolve());
      expect(threadImport.cleanup).toHaveBeenCalledTimes(1);
    }
    const active = ["finish", "edit"].includes(change);
    const draft = getComposerDraftSnapshot("draft");
    expect(draft.attachments).toHaveLength(active ? 1 : 0);
    expect(threadImport.write).toHaveBeenCalledTimes(
      active || change === "unmount during write" ? 1 : 0,
    );
    expect(appAtomRegistry.get(composerContextImportsAtom)).toEqual({});
    expect(draft.context?.records.every((record) => record.kind === "file") ?? true).toBe(true);
    if (active) expect(draft.text).toContain("t3-context://v1/file/");
    if (change === "edit") expect(draft.text).toMatch(/^I typed more while loading /);
  });
});
