import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, type ServerConfig } from "@t3tools/contracts";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";

import type { ZipTreeRow } from "./zipTree";

const files = vi.hoisted(() => new Map<string, Uint8Array>());
const navigation = vi.hoisted(() => ({ remove: null as (() => void) | null }));
const server = vi.hoisted(() => ({
  capabilities: { repositoryIdentity: false } as ServerConfig["environment"]["capabilities"],
  refresh: vi.fn(async () => "file:///first.zip"),
}));

vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({ environment: { capabilities: server.capabilities } }),
}));
vi.mock("../../state/assets", () => ({ useRefreshAssetUrl: () => server.refresh }));

vi.mock("react-native", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return {
    View: Slot,
    Text: Slot,
    ScrollView: Slot,
    ActivityIndicator: () => null,
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    Pressable: (props: {
      readonly children?: ReactNode;
      readonly accessibilityLabel?: string;
      readonly disabled?: boolean;
      readonly onPress?: () => void;
    }) => (
      <button
        aria-label={props.accessibilityLabel}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    TextInput: (props: {
      readonly accessibilityLabel?: string;
      readonly value: string;
      readonly onChangeText: (value: string) => void;
    }) => (
      <input
        aria-label={props.accessibilityLabel}
        value={props.value}
        onChange={(event) => props.onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    readonly data: ZipTreeRow[];
    readonly ListHeaderComponent: ReactNode;
    readonly ListEmptyComponent: ReactNode;
    readonly keyExtractor: (row: ZipTreeRow) => string;
    readonly renderItem: (input: { item: ZipTreeRow }) => ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0 ? props.ListEmptyComponent : null}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  Paths: { document: { uri: "file:///documents" } },
  File: class {
    constructor(private readonly uri: string) {}
    get exists() {
      return false;
    }
    readableStream() {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error(`Missing ZIP fixture: ${this.uri}`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => false }),
  usePreventRemove: (enabled: boolean, remove: () => void) => {
    navigation.remove = enabled ? remove : null;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
  useNativeLayoutMetrics: () => null,
  useDeviceType: () => "phone",
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("expo-glass-effect", () => ({ isGlassEffectAPIAvailable: () => false }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false }, panes: {} }),
}));
vi.mock("../../components/ui/Toolbar", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Toolbar: Object.assign(Slot, {
      Button: () => null,
      Menu: Slot,
      MenuAction: (props: {
        readonly children?: ReactNode;
        readonly disabled?: boolean;
        readonly onPress?: () => void;
      }) => (
        <button disabled={props.disabled} onClick={props.onPress}>
          {props.children}
        </button>
      ),
    }),
  };
});
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Progress", () => ({ Progress: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({
  FilePreviewModal: (
    props: ComponentProps<typeof import("../../components/FilePreviewModal").FilePreviewModal>,
  ) => (
    <div role="dialog" aria-label="Native file viewer">
      <button onClick={() => props.onOpenError?.(new Error("Connection lost"))}>Fail</button>
      <button onClick={props.onRequestClose}>Close</button>
    </div>
  ),
}));
vi.mock("../../lib/attachmentDownload", async (importOriginal) => {
  const { nativeViewerErrorMessage } =
    await importOriginal<typeof import("../../lib/attachmentDownload")>();
  return {
    nativeViewerErrorMessage,
    writeGeneratedAttachmentFile: vi.fn(),
    downloadAttachmentForPreview: vi.fn(async () => {
      throw new Error("Download started");
    }),
  };
});
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("./SourceFileSurface", () => ({
  SourceFileSurface: (props: { readonly contents: string }) => <pre>{props.contents}</pre>,
}));
vi.mock("./AudioFilePreview", () => ({ AudioFilePreview: () => null }));
vi.mock("./FileMarkdownPreview", () => ({ FileMarkdownPreview: () => null }));
vi.mock("./WorkspaceFileWebPreview", () => ({ WorkspaceFileWebPreview: () => null }));
vi.mock("../threads/HtmlRenderWebView", () => ({ HtmlRenderWebView: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    appearance: { codeWordBreak: false },
    themeVariables: { "--color-icon": "#000000" },
    setCodeWordBreak: () => {},
  }),
}));

import { ZipArchiveView } from "./ZipArchiveView";
import { AttachmentFileView } from "./AttachmentFileView";
import { AttachmentFileScreen } from "./AttachmentFileScreen";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import { alert } from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { composerDraftsAtom } from "../../state/use-composer-drafts";

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
  files.clear();
  navigation.remove = null;
  server.capabilities = { repositoryIdentity: false };
  server.refresh.mockClear();
  vi.mocked(downloadAttachmentForPreview).mockClear();
  vi.mocked(alert).mockClear();
  appAtomRegistry.set(composerDraftsAtom, {});
  files.set(
    "file:///first.zip",
    Uint8Array.from(
      atob(
        "UEsDBBQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAZmlyc3QudHh0Rmlyc3QgYXJjaGl2ZSBjb250ZW50c1BLAQIUAxQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAAAAAAAAAAACAAQAAAABmaXJzdC50eHRQSwUGAAAAAAEAAQA3AAAAPQAAAAAA",
      ),
      (character) => character.charCodeAt(0),
    ),
  );
  files.set(
    "file:///second.zip",
    Uint8Array.from(
      atob(
        "UEsDBBQAAAAAAAAAIVx7lgwlFwAAABcAAAAKAAAAc2Vjb25kLnR4dFNlY29uZCBhcmNoaXZlIGNvbnRlbnRzUEsBAhQDFAAAAAAAAAAhXHuWDCUXAAAAFwAAAAoAAAAAAAAAAAAAAIABAAAAAHNlY29uZC50eHRQSwUGAAAAAAEAAQA4AAAAPwAAAAAA",
      ),
      (character) => character.charCodeAt(0),
    ),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => {
    act(() => root.unmount());
    files.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const props: ComponentProps<typeof ZipArchiveView> = {
    name: "archive.zip",
    subtitle: "ZIP",
    tintColor: "#000000",
    sizeBytes: 0,
    uri: "file:///first.zip",
    isLocal: true,
    refresh: async () => null,
    environmentId: null,
    draftKey: null,
    questionPrefix: null,
    maxAttachmentBytes: undefined,
    onSave: () => {},
    onRemove: null,
  };
  return {
    container,
    root,
    props,
    render: async (input = props) => {
      await act(async () => root.render(<ZipArchiveView {...input} />));
    },
    settle: async (assert: () => void) => {
      await act(async () => vi.runAllTimersAsync());
      assert();
    },
  };
}

it.each(["uri", "refresh"] as const)(
  "returns to the file list when %s reloads the archive with a selected entry",
  async (changed) => {
    const screen = setup();
    await screen.render();
    await screen.settle(() =>
      expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
    );
    await act(async () =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
    );
    await screen.settle(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
    );

    await screen.render({ ...screen.props, subtitle: "Updated metadata" });
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents");

    await screen.render(
      changed === "uri"
        ? { ...screen.props, uri: "file:///second.zip" }
        : { ...screen.props, refresh: async () => null },
    );
    await screen.settle(() => {
      expect(
        screen.container.querySelector(
          `[aria-label="${changed === "uri" ? "second" : "first"}.txt"]`,
        ),
      ).not.toBeNull();
      expect(screen.container.textContent).not.toContain("Opening ZIP...");
    });
    expect(screen.container.querySelector("pre")).toBeNull();
    expect(screen.container.textContent).not.toContain("Couldn't read this file");
  },
);

it("keeps the ZIP filter and archive open when native Back closes a selected entry", async () => {
  const screen = setup();
  await screen.render();
  await screen.settle(() =>
    expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
  );
  const filter = screen.container.querySelector<HTMLInputElement>(
    '[aria-label="Filter files in ZIP"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      filter,
      "first",
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
  );
  await screen.settle(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
  );

  expect(navigation.remove).not.toBeNull();
  await act(async () => navigation.remove!());

  expect(screen.container.querySelector("pre")).toBeNull();
  expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull();
  expect(
    screen.container.querySelector<HTMLInputElement>('[aria-label="Filter files in ZIP"]')?.value,
  ).toBe("first");
});

it.each([
  ["normal file", "guide.bin", "application/octet-stream"],
  ["ZIP entry", "archive.zip", "application/zip"],
])(
  "does not offer Add to chat for a %s when attachment uploads are disabled",
  async (_, name, mimeType) => {
    const screen = setup();
    server.capabilities = {
      repositoryIdentity: false,
      attachmentUploads: false,
      fileAttachments: { maxUploadBytes: 1024 },
    };
    const { fetch } = await import("expo/fetch");
    vi.mocked(fetch, { partial: true }).mockImplementation(async () => ({
      ok: true,
      body: new Response(Uint8Array.from(files.get("file:///first.zip")!)).body,
    }));
    await act(async () =>
      screen.root.render(
        <AttachmentFileScreen
          route={{
            params: {
              environmentId: "environment-1",
              threadId: "thread-1",
              attachmentId: "attachment-1",
              name,
              mimeType,
              sizeBytes: "22",
            },
          }}
        />,
      ),
    );
    if (mimeType === "application/zip") {
      await screen.settle(() =>
        expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
      );
      await act(async () =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
      );
      await screen.settle(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
      );
    } else {
      await act(async () =>
        Array.from(screen.container.querySelectorAll("button"))
          .find((button) => button.textContent === "Close")!
          .click(),
      );
    }
    const add = Array.from(screen.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add to chat",
    );
    expect(add === undefined || add.disabled).toBe(true);
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({});
  },
);

it("rejects a known file above the provider limit before starting a download", async () => {
  const screen = setup();
  server.capabilities = {
    repositoryIdentity: false,
    attachmentUploads: true,
    fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2 },
  };
  await act(async () =>
    screen.root.render(
      <AttachmentFileScreen
        route={{
          params: {
            environmentId: "environment-1",
            threadId: "thread-1",
            attachmentId: "attachment-1",
            name: "large.bin",
            mimeType: "application/octet-stream",
            sizeBytes: String(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1),
          },
        }}
      />,
    ),
  );
  await act(async () =>
    Array.from(screen.container.querySelectorAll("button"))
      .find((button) => button.textContent === "Close")!
      .click(),
  );
  await act(async () =>
    Array.from(screen.container.querySelectorAll("button"))
      .find((button) => button.textContent === "Add to chat")!
      .click(),
  );
  expect(alert).toHaveBeenCalledWith(
    "Could not add file to chat",
    fileAttachmentTooLargeMessage("large.bin", PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  );
  expect(downloadAttachmentForPreview).not.toHaveBeenCalled();
  expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({});
});

it("clears the native error after a successful retry and keeps Add to chat available", async () => {
  const screen = setup();
  const onBack = vi.fn();
  await act(async () =>
    screen.root.render(
      <AttachmentFileView
        title="guide.pdf"
        subtitle="PDF"
        document={{
          kind: "pdf",
          renderedMode: null,
          activeMode: "source",
          uri: "file:///guide.pdf",
          content: null,
          table: null,
          error: null,
          needsText: false,
          setRendered: () => {},
          retry: () => {},
          revision: 0,
          share: async () => {},
          sharing: false,
        }}
        nativeSource={{ kind: "pdf", uri: "file:///guide.pdf", name: "guide.pdf" }}
        environmentId={null}
        htmlRender={false}
        addToChat={{ onPress: () => {}, busy: false }}
        onRemove={null}
        onBack={onBack}
      />,
    ),
  );
  const button = (label: string) =>
    Array.from(screen.container.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    )!;
  await act(async () => button("Fail").click());
  await act(async () => button("Close").click());
  const error = "The file could not be opened. Check the connection and try again.";
  expect(screen.container.textContent).toContain(error);

  await act(async () => button("Try again").click());
  await act(async () => button("Close").click());

  expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
  expect(onBack).not.toHaveBeenCalled();
  expect(button("Add to chat").disabled).toBe(false);
  expect(screen.container.textContent).not.toContain(error);
});
