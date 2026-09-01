import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingWindowCapture,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessStartMock,
  accessibilityProcessCloseMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityListMock,
  accessibilityTrustedMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getFileIconMock,
  getSourcesMock,
  macCaptureMock,
  linuxCaptureMock,
  linuxBackendMock,
  mediaAccessStatusMock,
  openExternalMock,
  registerShortcutMock,
  screenshotMock,
  shortcutForkArgs,
  shortcutForkOptions,
  shortcutProcesses,
  spawnedPollers,
  thumbnailFromPathMock,
  transitionScriptState,
  transitionShowMock,
  uiohookMock,
} = vi.hoisted(() => ({
  activeWindowMock: vi.fn(),
  animationSettingsMock: vi.fn(() => ({
    prefersReducedMotion: true,
    shouldRenderRichAnimation: false,
  })),
  accessibilityProcessStartMock: vi.fn(),
  accessibilityProcessCloseMock: vi.fn(),
  accessibilityProcessReadMock: vi.fn<
    (request: import("./WindowCaptureAccessibility.ts").WindowCaptureAccessibilityRequest) => {
      started: Promise<void>;
      result: Promise<
        import("./WindowCaptureAccessibility.ts").CapturedWindowAccessibilityContext | undefined
      >;
    }
  >(),
  accessibilityByPidMock: vi.fn(),
  accessibilityListMock: vi.fn(),
  accessibilityTrustedMock: vi.fn((_prompt = false) => true),
  allWindowsMock: vi.fn(
    () =>
      [] as Array<{
        getBounds: () => Electron.Rectangle;
        isDestroyed: () => boolean;
      }>,
  ),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    kind: "base" | "browser";
    loadCount: number;
    loadedUrls: Array<string>;
    opacities: Array<number>;
    options: Electron.BrowserWindowConstructorOptions;
    scripts: Array<string>;
    showCount: number;
    alwaysOnTopCalls: Array<[boolean, string | undefined]>;
  }>,
  focusedWindowMock: vi.fn(),
  getFileIconMock: vi.fn(),
  getSourcesMock: vi.fn(),
  macCaptureMock: vi.fn(),
  linuxCaptureMock: vi.fn<
    () => Promise<import("./LinuxWindowCapture.ts").LinuxWindowSnapshot | undefined>
  >(async () => undefined),
  linuxBackendMock: vi.fn(async () => "picker"),
  mediaAccessStatusMock: vi.fn(() => "not-determined"),
  openExternalMock: vi.fn(() => Promise.resolve()),
  registerShortcutMock: vi.fn(),
  screenshotMock: vi.fn(),
  shortcutForkArgs: [] as Array<ReadonlyArray<string>>,
  shortcutForkOptions: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  shortcutProcesses: [] as Array<{
    emit: (event: string, value?: unknown) => void;
    kill: ReturnType<typeof vi.fn>;
    on: (event: string, listener: (value: unknown) => void) => unknown;
    once: (event: string, listener: (value: unknown) => void) => unknown;
  }>,
  spawnedPollers: [] as Array<{
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
  thumbnailFromPathMock: vi.fn(),
  transitionScriptState: {
    rejectFlight: false,
    heldFlights: null as Array<() => void> | null,
  },
  transitionShowMock: vi.fn(),
  uiohookMock: {
    off: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("@crowecawcaw/xa11y", () => {
  const api = { screenshot: screenshotMock };
  return {
    ...api,
    default: api,
    App: { byPid: accessibilityByPidMock, list: accessibilityListMock },
  };
});
vi.mock("./WindowCaptureAccessibilityProcess.ts", () => ({
  startWindowCaptureAccessibilityProcess: () => {
    accessibilityProcessStartMock();
    return {
      read: accessibilityProcessReadMock,
      close: accessibilityProcessCloseMock,
    };
  },
}));
vi.mock("get-windows", () => ({ activeWindow: activeWindowMock }));
vi.mock("./MacWindowCapture.ts", () => ({ captureMacWindowSnapshot: macCaptureMock }));
vi.mock("./LinuxWindowCapture.ts", () => ({
  captureLinuxWindow: linuxCaptureMock,
  getLinuxCaptureBackend: linuxBackendMock,
  getLinuxCaptureSupport: async () => ({
    linuxBackend: await linuxBackendMock(),
    linuxFeedbackAvailable: false,
  }),
}));
vi.mock("uiohook-napi", () => ({ uIOhook: uiohookMock }));

vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    queueMicrotask(() => record.emitStderr("ready\n"));
    return child;
  },
  fork: (_path: string, args: ReadonlyArray<string>, options: { env?: NodeJS.ProcessEnv }) => {
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    const process = {
      emit: (event: string, value?: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      kill: vi.fn(() => true),
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return process;
      },
      once: (event: string, listener: (value: unknown) => void) => {
        const wrapped = (value: unknown) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
          );
          listener(value);
        };
        listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
        return process;
      },
    };
    shortcutForkArgs.push(args);
    shortcutForkOptions.push(options);
    shortcutProcesses.push(process);
    queueMicrotask(() => process.emit("message", "ready"));
    return process;
  },
}));
vi.mock("electron", () => {
  class BaseWindow {
    protected readonly state: (typeof flashWindows)[number];

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = {
        bounds:
          options.x === undefined ||
          options.y === undefined ||
          options.width === undefined ||
          options.height === undefined
            ? null
            : { x: options.x, y: options.y, width: options.width, height: options.height },
        destroyed: false,
        kind: "base",
        loadCount: 0,
        loadedUrls: [],
        opacities: options.opacity === undefined ? [] : [options.opacity],
        options,
        scripts: [],
        showCount: 0,
        alwaysOnTopCalls: [],
      };
      flashWindows.push(this.state);
    }

    destroy() {
      this.state.destroyed = true;
    }

    getBounds() {
      return this.state.bounds;
    }

    isDestroyed() {
      return this.state.destroyed;
    }

    setBounds(bounds: Electron.Rectangle) {
      this.state.bounds = bounds;
    }

    setIgnoreMouseEvents() {}

    setOpacity(opacity: number) {
      this.state.opacities.push(opacity);
    }

    setAlwaysOnTop(flag: boolean, level?: string) {
      this.state.alwaysOnTopCalls.push([flag, level]);
    }

    showInactive() {
      const shownBounds = transitionShowMock(this.state.bounds);
      if (shownBounds !== undefined) this.state.bounds = shownBounds;
      this.state.showCount += 1;
    }
  }

  class BrowserWindow extends BaseWindow {
    static getFocusedWindow() {
      return focusedWindowMock();
    }

    static getAllWindows() {
      return allWindowsMock();
    }

    readonly webContents;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(options);
      this.state.kind = "browser";
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
          if (!script.startsWith("window.startCaptureTransition")) return;
          if (transitionScriptState.rejectFlight) {
            transitionScriptState.rejectFlight = false;
            throw new Error("transition failed");
          }
          const held = transitionScriptState.heldFlights;
          if (held) await new Promise<void>((resolve) => held.push(resolve));
        },
      };
    }

    loadURL(url: string) {
      this.state.loadCount += 1;
      this.state.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  return {
    BaseWindow,
    BrowserWindow,
    app: { getFileIcon: getFileIconMock },
    desktopCapturer: { getSources: getSourcesMock },
    nativeImage: { createThumbnailFromPath: thumbnailFromPathMock },
    globalShortcut: { register: registerShortcutMock, unregister: vi.fn() },
    screen: {
      getDisplayMatching: (bounds: Electron.Rectangle) =>
        bounds.x < 0
          ? { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } }
          : { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      getAllDisplays: () => [
        { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
        { bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1_440, height: 900 } }),
      screenToDipRect: (_window: unknown, bounds: Electron.Rectangle) => bounds,
    },
    shell: { openExternal: openExternalMock },
    systemPreferences: {
      getAnimationSettings: () => animationSettingsMock(),
      getMediaAccessStatus: () => mediaAccessStatusMock(),
      isTrustedAccessibilityClient: (prompt: boolean) => accessibilityTrustedMock(prompt),
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWindowCapture from "./DesktopWindowCapture.ts";
import * as WindowCaptureAccessibility from "./WindowCaptureAccessibility.ts";
accessibilityProcessReadMock.mockImplementation((request) => ({
  started: Promise.resolve(),
  result: WindowCaptureAccessibility.readAccessibleWindowContext(
    request.active,
    request.platform,
    request.sourceTitle,
    request.imageSize,
  ),
}));
const decodePendingMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPendingWindowCapture),
);

import {
  WindowCaptureTransition,
  windowCaptureAnimationDurationMs,
  windowCaptureAnimationFlightBounds,
  windowCaptureAnimationOverlayBounds,
} from "./WindowCaptureTransition.ts";
const testLayer = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
) =>
  Layer.mergeAll(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        platform,
        stateDir: "/state",
        linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.succeed(
      DesktopClientSettings.DesktopClientSettings,
      DesktopClientSettings.DesktopClientSettings.of({
        get: Effect.succeed(initialSettings),
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: Effect.void,
        dispatchMenuAction: () => Effect.void,
        dispatchWindowCaptureReady: () => Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    FileSystem.layerNoop(fileSystemOverrides),
    Path.layer,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

it.effect("reads and acknowledges queued captures through Effect services", () => {
  const captureId = "12345678-1234-1234-1234-123456789abc";
  const captureDirectory = "/state/window-captures";
  const metadataPath = captureDirectory + "/" + captureId + ".json";
  const imagePath = captureDirectory + "/" + captureId + ".png";
  const removed: Array<string> = [];
  const metadata = JSON.stringify({
    id: captureId,
    name: "window.png",
    mimeType: "image/png",
    sizeBytes: 3,
    source: {
      kind: "window-capture",
      capturedAt: "2026-08-24T11:00:00.000Z",
      appName: "Editor",
      windowTitle: "main.ts",
    },
  });
  const layer = testLayer("linux", {
    readDirectory: () => Effect.succeed([captureId + ".json", "invalid.json"]),
    readFileString: (filePath) => Effect.succeed(filePath === metadataPath ? metadata : "invalid"),
    readFile: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    remove: (filePath) =>
      Effect.sync(() => {
        removed.push(filePath);
      }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const pending = yield* service.listPending;
      assert.deepEqual(
        pending.map((capture) => capture.id),
        [captureId],
      );

      const capture = yield* service.read(captureId);
      assert.strictEqual(capture.dataUrl, "data:image/png;base64,AQID");

      yield* service.acknowledge(captureId);
      assert.deepEqual(removed.sort(), [imagePath, metadataPath].sort());
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("captures the active Windows window without enumerating desktop sources", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  screenshotMock.mockReset().mockResolvedValue({ width: 800, height: 600, toPng: () => png });
  getSourcesMock.mockReset().mockResolvedValue([
    {
      id: "window:42:0",
      name: "Editor",
      thumbnail: { isEmpty: () => false, toPNG: () => png },
    },
  ]);
  const writtenFiles: Array<[string, Uint8Array]> = [];
  const layer = testLayer("win32", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: (path, bytes) =>
      Effect.sync(() => {
        writtenFiles.push([path, bytes]);
      }),
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;

      assert.deepEqual(screenshotMock.mock.calls, [[{ region: active.bounds }]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.deepEqual(writtenFiles[0]?.[1], png);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("skips accessibility capture when the setting is disabled", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  screenshotMock.mockReset().mockResolvedValue({ width: 800, height: 600, toPng: () => png });
  accessibilityProcessStartMock.mockClear();
  accessibilityProcessReadMock.mockClear();
  accessibilityByPidMock.mockClear();
  const layer = testLayer("win32", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        windowCaptureIncludeAccessibility: false,
      });
      yield* service.captureNow;

      assert.lengthOf(accessibilityProcessStartMock.mock.calls, 0);
      assert.lengthOf(accessibilityProcessReadMock.mock.calls, 0);
      assert.lengthOf(accessibilityByPidMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("rejects X11 capture without registering shortcuts or loading capture backends", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "x11");
  vi.stubEnv("WAYLAND_DISPLAY", "");
  linuxCaptureMock.mockClear();
  activeWindowMock.mockClear();
  registerShortcutMock.mockClear();
  shortcutProcesses.length = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true });
      const state = yield* service.state;
      assert.equal(state.mode, "unavailable");
      assert.include(state.message, "Wayland");
      const result = yield* Effect.flip(service.captureNow);
      assert.equal(result.operation, "unsupported");
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.lengthOf(shortcutProcesses, 0);
      assert.lengthOf(linuxCaptureMock.mock.calls, 0);
      assert.lengthOf(activeWindowMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("persists GNOME text when AT-SPI omits the identified window's screen position", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  flashWindows.length = 0;
  const window = {
    title: "Editor",
    appName: "Text Editor",
    appIdentifier: "org.gnome.TextEditor.desktop",
    processId: 123,
    bounds: { x: 479, y: 342, width: 700, height: 520 },
  };
  linuxCaptureMock.mockResolvedValueOnce({ png: Buffer.from([1, 2, 3]), window });
  activeWindowMock.mockClear();
  getSourcesMock.mockClear();
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 700, height: 520 },
        active: true,
        children: async () => [
          {
            role: "button",
            name: "Save",
            bounds: { x: 10, y: 20, width: 80, height: 24 },
            focused: true,
            actions: ["press"],
            children: async () => [],
          },
        ],
        tree: async () => ({ name: "Editor", value: "Verified text", children: [] }),
      },
    ],
  });
  let metadata = "";
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
      const saved = yield* decodePendingMetadata(metadata);
      assert.equal(saved.source.appName, "Text Editor");
      assert.equal(saved.source.appIdentifier, window.appIdentifier);
      assert.include(saved.source.accessibleText, "Verified text");
      assert.deepInclude(saved.source.accessibility, {
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 700, height: 520 },
        truncated: false,
      });
      assert.deepInclude(
        saved.source.accessibility?.format === "element-tree"
          ? saved.source.accessibility.root
          : undefined,
        {
          role: "window",
          name: "Editor",
          bounds: { x: 0, y: 0, width: 700, height: 520 },
          state: { active: true },
        },
      );
      assert.isNull(
        saved.source.accessibility?.format === "element-tree"
          ? saved.source.accessibility.root.children[0]?.bounds
          : undefined,
      );
      assert.lengthOf(flashWindows, 0);
    }),
  ).pipe(
    Effect.provide(
      testLayer("linux", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("does not fall back to the picker when an automatic Wayland capture fails", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  linuxCaptureMock.mockRejectedValueOnce(new Error("Capture denied"));
  getSourcesMock.mockClear();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const failure = yield* Effect.flip(service.captureNow);
      assert.equal(failure.operation, "capture");
      assert.lengthOf(getSourcesMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(
      testLayer("linux", {
        makeDirectory: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect(
  "logs a GNOME activation failure and completes the shell flight before acknowledging the image",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const order: string[] = [];
    const activationFailure = new Error("Activation failed");
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => logs.push(message));
    const feedback = {
      animationStarted: true,
      activate: async () => {
        order.push("activate");
        throw activationFailure;
      },
      animateTo: async () => {
        order.push("land");
      },
      complete: async () => {
        order.push("complete");
      },
      close: () => {
        order.push("close");
      },
    };
    linuxCaptureMock.mockImplementationOnce(async () => {
      order.push("snapshot");
      return { png: Buffer.from([1, 2, 3]), feedback };
    });
    focusedWindowMock.mockReturnValue(undefined);
    const destination = {
      getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      getTitle: () => "T3 Code",
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
    };
    allWindowsMock.mockReturnValue([destination]);
    let saved = "";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopWindowCapture.make;
        yield* service.captureNow;
        assert.deepEqual(order, ["snapshot", "activate"]);
        const warning = logs.find(
          (message) =>
            Array.isArray(message) &&
            message[0] === "GNOME could not activate T3 Code after window capture",
        );
        assert.strictEqual(Array.isArray(warning) ? warning[1] : undefined, activationFailure);
        const pending = yield* decodePendingMetadata(saved);
        yield* service.setAnimationDestination(pending.id, {
          frame: { x: 0, y: 0, width: 10, height: 10 },
          relativeFrame: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
          backgroundColor: "white",
          borderColor: "black",
          borderWidth: 1,
          cornerRadius: 8,
          scaleFactor: 1,
        });
        yield* service.acknowledge(pending.id);
        assert.deepEqual(order, ["snapshot", "activate", "land", "complete", "delete", "delete"]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer("linux", {
            makeDirectory: () => Effect.void,
            rename: () => Effect.void,
            writeFile: () => Effect.void,
            writeFileString: (_, value) =>
              Effect.sync(() => {
                saved = value;
              }),
            remove: () =>
              Effect.sync(() => {
                order.push("delete");
              }),
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          allWindowsMock.mockReturnValue([]);
          vi.unstubAllEnvs();
        }),
      ),
    );
  },
);

it.effect("does not read unverified accessibility context for a Wayland portal capture", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const png = Buffer.from([1, 2, 3]);
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      name: "Unrelated app",
      children: async () => [
        {
          name: "Untitled",
          tree: async () => ({ name: "Untitled", value: "private text", children: [] }),
        },
      ],
    },
  ]);
  getSourcesMock.mockReset().mockResolvedValue([
    {
      id: "window:42:0",
      name: "Untitled",
      thumbnail: { isEmpty: () => false, toPNG: () => png },
    },
  ]);
  const layer = testLayer("linux", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;

      assert.lengthOf(accessibilityListMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
});

it.effect("uses display-local macOS capture surfaces across the source and main displays", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "macos",
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({
    source: { name: "Terminal" },
    png,
  });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  let blur: () => void = () => undefined;
  const mainShowMock = vi.fn();
  focusedWindowMock.mockReturnValue({
    getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
    hide: () => queueMicrotask(blur),
    once: (_event: string, listener: () => void) => {
      blur = listener;
    },
    removeListener: () => undefined,
    isDestroyed: () => false,
    show: mainShowMock,
  });
  transitionShowMock.mockClear();
  flashWindows.length = 0;
  const layer = testLayer("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;

      const transitionWindows = flashWindows.filter((window) => window.kind === "browser");
      assert.deepEqual(
        transitionWindows.map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
      for (const transitionWindow of transitionWindows) {
        assert.deepEqual(transitionWindow.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
      }
      assert.isBelow(
        mainShowMock.mock.invocationCallOrder[0]!,
        transitionShowMock.mock.invocationCallOrder[0]!,
      );
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => focusedWindowMock.mockReset())));
});

it.effect("starts accessibility lookup before restoring the captured app", () => {
  const png = Buffer.from([1, 2, 3]);
  const order: string[] = [];
  const active = {
    platform: "macos",
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  accessibilityProcessReadMock.mockImplementationOnce(() => {
    order.push("accessibility");
    return {
      started: Promise.resolve(),
      result: Promise.resolve(undefined),
    };
  });
  macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Terminal" }, png });
  let blur: () => void = () => undefined;
  focusedWindowMock.mockReturnValue({
    getBounds: () => ({ x: 0, y: 0, width: 1_200, height: 800 }),
    hide: () => queueMicrotask(blur),
    once: (_event: string, listener: () => void) => {
      blur = listener;
    },
    removeListener: () => undefined,
    isDestroyed: () => false,
    show: () => {
      order.push("restore");
    },
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;

      assert.isBelow(order.indexOf("accessibility"), order.indexOf("restore"));
    }),
  ).pipe(
    Effect.provide(
      testLayer("darwin", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    ),
    Effect.ensuring(Effect.sync(() => focusedWindowMock.mockReset())),
  );
});

it.effect("uses the unfocused main window for a macOS cross-display transition", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "macos",
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Terminal" }, png });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([
    {
      getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
      isDestroyed: () => false,
    },
  ]);
  flashWindows.length = 0;
  const layer = testLayer("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.captureNow;

      assert.deepEqual(
        flashWindows.filter((window) => window.kind === "browser").map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.ensuring(
      Effect.sync(() => {
        focusedWindowMock.mockReset();
        allWindowsMock.mockReset();
      }),
    ),
  );
});

function fakeIcon(label: string, empty = false): Electron.NativeImage {
  return {
    isEmpty: () => empty,
    resize: ({ width, height, quality }) => ({
      toDataURL: (options) =>
        "data:image/png;base64," +
        label +
        ":" +
        width +
        "x" +
        height +
        ":" +
        quality +
        "@" +
        options?.scaleFactor,
    }),
  } as Electron.NativeImage;
}

it.each([
  ["OS app", fakeIcon("captured"), fakeIcon("file"), "file"],
  ["captured app", fakeIcon("captured"), fakeIcon("file", true), "captured"],
])("exports the %s icon at high density", (_source, capturedIcon, fileIcon, expectedLabel) => {
  const dataUrl = DesktopWindowCapture.windowCaptureIconDataUrl(capturedIcon, fileIcon);

  assert.strictEqual(dataUrl, "data:image/png;base64," + expectedLabel + ":64x64:best@2");
});

const activeEditor = {
  owner: { path: "/Applications/Editor.app" },
} as Parameters<typeof DesktopWindowCapture.iconDataUrl>[1];

it("prefers the bundle thumbnail for macOS app icons", async () => {
  getFileIconMock.mockReset();
  thumbnailFromPathMock.mockReset();
  thumbnailFromPathMock.mockResolvedValue(fakeIcon("thumb"));

  const dataUrl = await DesktopWindowCapture.iconDataUrl(
    { appIcon: fakeIcon("captured") },
    activeEditor,
    "darwin",
  );

  assert.deepEqual(thumbnailFromPathMock.mock.calls, [
    ["/Applications/Editor.app", { width: 64, height: 64 }],
  ]);
  assert.lengthOf(getFileIconMock.mock.calls, 0);
  assert.strictEqual(dataUrl, "data:image/png;base64,thumb:64x64:best@2");
});

it.each([
  [
    "a failed thumbnail on darwin",
    "darwin" as const,
    () => thumbnailFromPathMock.mockRejectedValue(new Error("no thumbnail")),
  ],
  ["other platforms", "win32" as const, () => {}],
])(
  "requests the file icon at a size supported on macOS after %s",
  async (_case, platform, arrange) => {
    getFileIconMock.mockReset();
    thumbnailFromPathMock.mockReset();
    arrange();
    getFileIconMock.mockResolvedValue(fakeIcon("file"));

    const dataUrl = await DesktopWindowCapture.iconDataUrl(
      { appIcon: fakeIcon("captured") },
      activeEditor,
      platform,
    );

    assert.deepEqual(getFileIconMock.mock.calls, [
      ["/Applications/Editor.app", { size: "normal" }],
    ]);
    assert.strictEqual(dataUrl, "data:image/png;base64,file:64x64:best@2");
  },
);

it("uses the primary display for portal flash feedback", () => {
  assert.deepEqual(DesktopWindowCapture.windowCaptureFlashBounds(undefined, "linux"), {
    x: 0,
    y: 0,
    width: 1_440,
    height: 900,
  });
});

it("uses the operating system animation policy", () => {
  assert.isTrue(
    DesktopWindowCapture.shouldAnimateWindowCapture({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    }),
  );
  assert.isFalse(
    DesktopWindowCapture.shouldAnimateWindowCapture({
      prefersReducedMotion: true,
      shouldRenderRichAnimation: true,
    }),
  );
});

it("keeps the transition flash subdued", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      true,
    );

    const html = decodeURIComponent(flashWindows[0]?.loadedUrls[0] ?? "");
    assert.include(
      html,
      "[{opacity:.08},{offset:.38,opacity:.08},{offset:.68,opacity:.02},{opacity:0}]",
    );
  } finally {
    transition.dispose();
  }
});

it("presents the landed card before completing the transition", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );

    const html = decodeURIComponent(flashWindows[0]?.loadedUrls[0] ?? "");
    assert.include(
      html,
      "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
  } finally {
    transition.dispose();
  }
});

it("scales transition timing with travel distance", () => {
  const source = { x: 0, y: 0, width: 200, height: 100 };
  assert.strictEqual(windowCaptureAnimationDurationMs(source, source), 280);
  const near = windowCaptureAnimationDurationMs(source, {
    x: 100,
    y: 0,
    width: 200,
    height: 100,
  });
  const far = windowCaptureAnimationDurationMs(source, {
    x: 1_000,
    y: 0,
    width: 200,
    height: 100,
  });

  assert.isAtLeast(near, 280);
  assert.isBelow(far, 570);
  assert.isAbove(far, near);
});

it("bounds the transition surface to its displays and flight", () => {
  assert.deepEqual(
    windowCaptureAnimationOverlayBounds([
      { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
      { bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
    ]),
    { x: -1_920, y: -200, width: 3_360, height: 1_280 },
  );
  assert.deepEqual(
    windowCaptureAnimationFlightBounds(
      { x: 100, y: 50, width: 900, height: 600 },
      { x: 1_200, y: 800, width: 208, height: 112 },
    ),
    { x: 28, y: -22, width: 1_452, height: 1_006 },
  );
});

it("keeps cross-display handoff surfaces local to each display", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(
      flashWindows.map((window) => window.bounds),
      [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: -200, width: 1_440, height: 900 },
      ],
    );
    for (const window of flashWindows) {
      assert.isTrue(
        window.scripts.some((script) => script.startsWith("window.startCaptureTransition")),
      );
    }
  } finally {
    transition.dispose();
  }
});

it("keeps flying on the destination display when the capture display fails", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transitionScriptState.rejectFlight = true;
    transitionScriptState.heldFlights = [];
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    let landed = false;
    const landing = transition.waitForLanding("capture-1").then(() => {
      landed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.lengthOf(transitionScriptState.heldFlights, 1);
    assert.isFalse(landed);

    for (const release of transitionScriptState.heldFlights) release();
    await landing;
  } finally {
    transitionScriptState.rejectFlight = false;
    transitionScriptState.heldFlights = null;
    transition.dispose();
  }
});

it("keeps same-display motion inside one stable surface", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 200, y: 100, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(flashWindows[0]?.bounds, {
      x: 0,
      y: -200,
      width: 1_440,
      height: 900,
    });
    assert.isTrue(
      flashWindows[0]?.scripts.some((script) => script.startsWith("window.startCaptureTransition")),
    );
  } finally {
    transition.dispose();
  }
});

it("rebases the transition when macOS moves the visible surface", async () => {
  flashWindows.length = 0;
  transitionShowMock.mockReset().mockReturnValueOnce({
    x: 0,
    y: -161,
    width: 1_440,
    height: 900,
  });
  const transition = new WindowCaptureTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 200, y: 100, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.include(
      flashWindows[0]?.scripts ?? [],
      'window.rebaseCaptureSource({"x":100,"y":211,"width":900,"height":600})',
    );
    assert.isTrue(
      flashWindows[0]?.scripts.some(
        (script) =>
          script.startsWith("window.startCaptureTransition") &&
          script.includes('"frame":{"x":600,"y":561,"width":208,"height":112}'),
      ),
    );
  } finally {
    transitionShowMock.mockReset();
    transition.dispose();
  }
});

it("keeps the Windows transition above the revealed main window", async () => {
  flashWindows.length = 0;
  const transition = new WindowCaptureTransition({
    alwaysOnTopLevel: "pop-up-menu",
  });

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );

    assert.deepEqual(flashWindows[0]?.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
  } finally {
    transition.dispose();
  }
});

it("does not let a failed transition fail landing or capture completion", async () => {
  flashWindows.length = 0;
  transitionScriptState.rejectFlight = true;
  const transition = new WindowCaptureTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transition.animateTo("capture-1", {
      frame: { x: 20, y: 20, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    await transition.waitForLanding("capture-1");
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
});

it("bounds source thumbnails for large windows", () => {
  assert.deepEqual(
    DesktopWindowCapture.windowCaptureThumbnailSize({
      bounds: { x: 0, y: 0, width: 6_000, height: 4_000 },
    } as Parameters<typeof DesktopWindowCapture.windowCaptureThumbnailSize>[0]),
    { width: 2_560, height: 1_600 },
  );
});

it.each(["darwin", "win32"] as const)(
  "extracts the same structured accessibility tree on %s",
  async (platform) => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({ name: "Editor", children: [{ name: "Save", children: [] }] }),
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 300, y: 350, width: 100, height: 50 },
          children: async () => [],
        },
      ],
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityListMock.mockReset().mockResolvedValue([{ pid: 123, asElement: () => window }]);

    const result = await WindowCaptureAccessibility.readAccessibleWindowContext(
      { title: "Editor", bounds, owner: { processId: 123 } },
      platform,
      "Editor",
      { width: 1_600, height: 1_200 },
    );

    assert.equal(result?.accessibility?.format, "element-tree");
    assert.equal(
      result?.accessibility?.format === "element-tree"
        ? result.accessibility.root.children[0]?.name
        : undefined,
      "Save",
    );
    assert.lengthOf(accessibilityByPidMock.mock.calls, platform === "win32" ? 0 : 1);
    assert.lengthOf(accessibilityListMock.mock.calls, platform === "win32" ? 1 : 0);
  },
);

it.each(["darwin", "win32"] as const)(
  "still requires matching accessibility screen positions on %s",
  async (platform) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
    const window = {
      name: "Editor",
      bounds: { x: 0, y: 0, width: 700, height: 520 },
      tree,
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityListMock.mockReset().mockResolvedValue([{ pid: 123, asElement: () => window }]);
    try {
      assert.isUndefined(
        await WindowCaptureAccessibility.readAccessibleWindowText(
          {
            title: "Editor",
            bounds: { x: 479, y: 342, width: 700, height: 520 },
            owner: { processId: 123 },
          },
          platform,
          "Editor",
        ),
      );
      assert.lengthOf(tree.mock.calls, 0);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each([
  { names: ["⠙ t3code"], expected: "Verified text" },
  { names: ["⠋ t3code", "⠙ t3code"], expected: undefined },
])("reads a changing Wayland title only when unambiguous: $names", async ({ names, expected }) => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const tree = vi.fn(async () => ({ value: "Verified text", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () =>
      names.map((name) => ({
        name,
        bounds: { x: 0, y: 0, width: 700, height: 520 },
        tree,
      })),
  });
  try {
    assert.strictEqual(
      await WindowCaptureAccessibility.readAccessibleWindowText(
        {
          title: "⠋ t3code",
          bounds: { x: 479, y: 342, width: 700, height: 520 },
          owner: { processId: 123 },
        },
        "linux",
        "⠋ t3code",
      ),
      expected,
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
    assert.lengthOf(tree.mock.calls, expected ? 1 : 0);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([20, 1_350, 2_999])(
  "includes accessibility text as soon as a %d ms read completes",
  async (duration) => {
    vi.useFakeTimers();
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const tree = Promise.withResolvers<{ value: string; children: Array<never> }>();
    const started = Promise.withResolvers<void>();
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          name: "Mozilla Firefox",
          bounds: { x: 0, y: 0, width: 1_373, height: 928 },
          tree: () => {
            started.resolve();
            return tree.promise;
          },
        },
      ],
    });

    try {
      const result = WindowCaptureAccessibility.readAccessibleWindowText(
        {
          title: "Mozilla Firefox",
          owner: { processId: 42 },
          bounds: { x: 67, y: 32, width: 1_373, height: 928 },
        },
        "linux",
        "Mozilla Firefox",
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(duration);
      tree.resolve({ value: "Firefox page text", children: [] });

      assert.strictEqual(await result, "Firefox page text");
      assert.strictEqual(vi.getTimerCount(), 0);
    } finally {
      tree.resolve({ value: "", children: [] });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  },
);

it("falls back to completed flat text when rich traversal reaches the deadline", async () => {
  vi.useFakeTimers();
  const richChildren = Promise.withResolvers<Array<never>>();
  const richStarted = Promise.withResolvers<void>();
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        tree: async () => ({ value: "Complete flat text", children: [] }),
        children: () => {
          richStarted.resolve();
          return richChildren.promise;
        },
      },
    ],
  });

  try {
    const result = WindowCaptureAccessibility.readAccessibleWindowContext(
      {
        title: "Editor",
        owner: { processId: 42 },
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      "darwin",
      "Editor",
      { width: 1_600, height: 1_200 },
    );
    await richStarted.promise;
    await vi.advanceTimersByTimeAsync(3_000);

    assert.deepEqual(await result, {
      accessibleText: "Complete flat text",
      accessibility: {
        format: "flat-text",
        text: "Complete flat text",
        truncated: false,
      },
    });
  } finally {
    richChildren.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("times out after three seconds without overlapping the outstanding accessibility read", async () => {
  vi.useFakeTimers();
  accessibilityByPidMock.mockReset();
  const read = Promise.withResolvers<{ children: () => Promise<Array<never>> }>();
  const started = Promise.withResolvers<void>();
  accessibilityByPidMock.mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  const active = {
    title: "main.ts",
    owner: { processId: 42 },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  } as Parameters<typeof WindowCaptureAccessibility.readAccessibleWindowText>[0];

  try {
    const first = WindowCaptureAccessibility.readAccessibleWindowText(active, "darwin", "main.ts");
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(2_999);
    assert.isFalse(settled);
    await vi.advanceTimersByTimeAsync(1);
    assert.isUndefined(await first);
    assert.strictEqual(vi.getTimerCount(), 0);
    assert.isUndefined(
      await WindowCaptureAccessibility.readAccessibleWindowText(active, "darwin", "main.ts"),
    );
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 1);

    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    accessibilityByPidMock.mockResolvedValueOnce({ children: async () => [] });
    assert.isUndefined(
      await WindowCaptureAccessibility.readAccessibleWindowText(active, "darwin", "main.ts"),
    );
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 2);
  } finally {
    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("uses native opacity for a short-lived flash", async () => {
  vi.useFakeTimers();
  flashWindows.length = 0;
  const flash = new DesktopWindowCapture.WindowCaptureFlash();
  const bounds = { x: 10, y: 20, width: 800, height: 600 };

  try {
    await flash.showAnimated(bounds);

    assert.lengthOf(flashWindows, 1);
    assert.strictEqual(flashWindows[0]?.kind, "base");
    assert.strictEqual(flashWindows[0]?.options.transparent, false);
    assert.strictEqual(flashWindows[0]?.loadCount, 0);
    assert.deepEqual(flashWindows[0]?.bounds, bounds);
    assert.strictEqual(flashWindows[0]?.showCount, 1);
    assert.lengthOf(flashWindows[0]?.scripts ?? [], 0);
    await vi.advanceTimersByTimeAsync(180);
    assert.isTrue(flashWindows[0]?.destroyed);
    assert.isAbove(flashWindows[0]?.opacities.length ?? 0, 1);
    assert.strictEqual(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

it.effect("does not request permissions or create the flash during desktop startup", () => {
  flashWindows.length = 0;
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureEnabled: true,
    windowCaptureFlash: true,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.initialize;
      assert.lengthOf(flashWindows, 0);
      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(testLayer("darwin", {}, Option.some(settings))));
});

it.effect("does not request macOS permissions while synchronizing enabled settings", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("requests macOS permissions only for an explicit enable action", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.requestPermissions(true);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[true]]);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("does not request macOS accessibility permission when capture data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.requestPermissions(false);

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("registers macOS capture without accessibility permission when data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        windowCaptureEnabled: true,
        windowCaptureIncludeAccessibility: false,
      });

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.isTrue((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("starts the Shift listener outside the Electron main process", () => {
  shortcutForkArgs.length = 0;
  shortcutForkOptions.length = 0;
  shortcutProcesses.length = 0;
  uiohookMock.start.mockClear();
  const settings = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);
      const state = yield* service.state;

      assert.isTrue(state.shortcutRegistered);
      assert.lengthOf(shortcutProcesses, 1);
      assert.deepEqual(shortcutForkArgs[0], ["shift"]);
      assert.strictEqual(shortcutForkOptions[0]?.env?.ELECTRON_RUN_AS_NODE, "1");
      assert.strictEqual(uiohookMock.start.mock.calls.length, 0);

      shortcutProcesses[0]?.emit("exit", 1);
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      assert.isFalse((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("passes the configured modifier pair to the listener process", () => {
  shortcutForkArgs.length = 0;
  shortcutProcesses.length = 0;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureEnabled: true,
    windowCaptureShortcut: { kind: "modifier-pair", modifier: "meta" },
  } satisfies ClientSettings;

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);
      const state = yield* service.state;

      assert.isTrue(state.shortcutRegistered);
      assert.deepEqual(shortcutForkArgs[0], ["meta"]);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("registers a configured key chord instead of the Shift listener", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  shortcutProcesses.length = 0;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureEnabled: true,
    windowCaptureShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);

      assert.isTrue((yield* service.state).shortcutRegistered);
      assert.strictEqual(registerShortcutMock.mock.calls[0]?.[0], "Control+Alt+K");
      assert.lengthOf(shortcutProcesses, 0);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("keeps shortcut registration errors off the capture status", () => {
  registerShortcutMock.mockReset().mockReturnValue(false);
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureEnabled: true,
    windowCaptureShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.isNull(state.message);
      assert.equal(
        state.shortcutMessage,
        "This shortcut is already used by the system or another app.",
      );
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("defers ordinary Wayland shortcut registration until settings are applied", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(false);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const conflict = yield* service.checkShortcut({
        key: "c",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        modKey: false,
      });
      const available = yield* service.checkShortcut({
        key: "9",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        modKey: false,
      });
      assert.isFalse(conflict.available);
      assert.isTrue(available.available);
      assert.match(available.message ?? "", /desktop will confirm/);

      const pair = yield* service.checkShortcut({
        kind: "modifier-pair",
        modifier: "meta",
      });
      assert.isFalse(pair.available);
      assert.match(pair.message ?? "", /Modifier-pair shortcuts aren't available/);
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("does not register a Wayland modifier-pair shortcut when enabled", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(true);
  const settings = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.isFalse(state.shortcutRegistered);
      assert.deepEqual(state.shortcut, DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut);
      assert.match(state.shortcutMessage ?? "", /Modifier-pair shortcuts aren't available/);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("reports Wayland shortcut submission without claiming the desktop bound it", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(true);
  const shortcut = {
    key: "9",
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    modKey: false,
  } as const;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureEnabled: true,
    windowCaptureShortcut: shortcut,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.equal(registerShortcutMock.mock.calls[0]?.[0], "Control+Shift+9");
      assert.isTrue(state.shortcutRegistered);
      assert.deepEqual(state.shortcut, shortcut);
      assert.equal(
        state.shortcutMessage,
        "Requested from your desktop. Approve the system prompt to enable this shortcut.",
      );

      registerShortcutMock.mockReturnValue(false);
      yield* service.configure(settings);
      const failed = yield* service.state;
      assert.isFalse(failed.shortcutRegistered);
      assert.equal(
        failed.shortcutMessage,
        "Your desktop could not register this shortcut. Check global shortcut support and permissions.",
      );
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("advises about the system menu for a meta pair on Windows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const result = yield* service.checkShortcut({ kind: "modifier-pair", modifier: "meta" });
      assert.isTrue(result.available);
      assert.match(result.message ?? "", /Super \+ Super is observed/);
      assert.match(result.message ?? "", /system's own menu/);
    }),
  ).pipe(Effect.provide(testLayer("win32"))),
);

it.effect("probes macOS modifier pairs with the flags poller", () => {
  spawnedPollers.length = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const result = yield* service.checkShortcut({ kind: "both-shift-keys" });
      assert.isTrue(result.available);
      assert.match(result.message ?? "", /Shift \+ Shift is observed/);
      assert.notMatch(result.message ?? "", /Input Monitoring/);
      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["2", "4"]);
      assert.strictEqual(spawnedPollers[0]?.kill.mock.calls.length, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("registers macOS modifier pairs through the flags poller", () => {
  spawnedPollers.length = 0;
  shortcutProcesses.length = 0;
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    windowCaptureShortcut: { kind: "modifier-pair", modifier: "meta" },
  } satisfies ClientSettings;

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      yield* service.configure({ ...settings, windowCaptureEnabled: true });
      const state = yield* service.state;

      assert.lengthOf(shortcutProcesses, 0);
      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["8", "16"]);
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("waits to apply settings while permissions are pending", () => {
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValueOnce("not-determined").mockReturnValue("granted");
  let finishPermissionRequest: (() => void) | undefined;
  getSourcesMock.mockImplementationOnce(
    () =>
      new Promise<Array<never>>((resolve) => {
        finishPermissionRequest = () => resolve([]);
      }),
  );
  const layer = testLayer("darwin");

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopWindowCapture.make;
      const enabled = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true };
      const permissionFiber = yield* service.requestPermissions(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      if (!finishPermissionRequest) throw new Error("Permission request did not start");
      const finishPermission = finishPermissionRequest;

      const configureFiber = yield* service.configure(enabled).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isFalse((yield* service.state).shortcutRegistered);
      finishPermission();
      yield* Fiber.join(permissionFiber);
      yield* Fiber.join(configureFiber);

      const state = yield* service.state;
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layer));
});
