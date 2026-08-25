import { assert, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const {
  accessibilityByPidMock,
  flashWindows,
  getFileIconMock,
  getSourcesMock,
  openExternalMock,
  registerShortcutMock,
  shortcutForkOptions,
  shortcutProcesses,
  uiohookMock,
} = vi.hoisted(() => ({
  accessibilityByPidMock: vi.fn(),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    kind: "base" | "browser";
    loadCount: number;
    opacities: Array<number>;
    options: Electron.BrowserWindowConstructorOptions;
    scripts: Array<string>;
    showCount: number;
  }>,
  getFileIconMock: vi.fn(),
  getSourcesMock: vi.fn(),
  openExternalMock: vi.fn(() => Promise.resolve()),
  registerShortcutMock: vi.fn(),
  shortcutForkOptions: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  shortcutProcesses: [] as Array<{
    emit: (event: string, value?: unknown) => void;
    kill: ReturnType<typeof vi.fn>;
    on: (event: string, listener: (value: unknown) => void) => unknown;
    once: (event: string, listener: (value: unknown) => void) => unknown;
  }>,
  uiohookMock: {
    off: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("@crowecawcaw/xa11y", () => ({ App: { byPid: accessibilityByPidMock } }));
vi.mock("uiohook-napi", () => ({ uIOhook: uiohookMock }));

vi.mock("node:child_process", () => ({
  fork: (_path: string, _args: ReadonlyArray<string>, options: { env?: NodeJS.ProcessEnv }) => {
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
        opacities: options.opacity === undefined ? [] : [options.opacity],
        options,
        scripts: [],
        showCount: 0,
      };
      flashWindows.push(this.state);
    }

    destroy() {
      this.state.destroyed = true;
    }

    hide() {}

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

    showInactive() {
      this.state.showCount += 1;
    }
  }

  class BrowserWindow extends BaseWindow {
    static getFocusedWindow() {
      return null;
    }

    readonly webContents;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(options);
      this.state.kind = "browser";
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
        },
      };
    }

    loadURL() {
      this.state.loadCount += 1;
      return Promise.resolve();
    }
  }

  return {
    BaseWindow,
    BrowserWindow,
    app: { getFileIcon: getFileIconMock },
    desktopCapturer: { getSources: getSourcesMock },
    globalShortcut: { register: registerShortcutMock, unregister: vi.fn() },
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1_440, height: 900 } }),
    },
    shell: { openExternal: openExternalMock },
    systemPreferences: {
      getMediaAccessStatus: () => "not-determined",
      isTrustedAccessibilityClient: () => true,
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWindowCapture from "./DesktopWindowCapture.ts";

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
        dispatchMenuAction: () => Effect.void,
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

  assert.strictEqual(dataUrl, "data:image/png;base64," + expectedLabel + ":32x32:best@2");
});

it("requests the file icon at a size supported on macOS", async () => {
  getFileIconMock.mockReset();
  getFileIconMock.mockResolvedValue(fakeIcon("file"));
  const active = {
    owner: { path: "/Applications/Editor.app" },
  } as Parameters<typeof DesktopWindowCapture.iconDataUrl>[1];

  const dataUrl = await DesktopWindowCapture.iconDataUrl({ appIcon: fakeIcon("captured") }, active);

  assert.deepEqual(getFileIconMock.mock.calls, [["/Applications/Editor.app", { size: "normal" }]]);
  assert.strictEqual(dataUrl, "data:image/png;base64,file:32x32:best@2");
});

it("uses the primary display for portal flash feedback", () => {
  assert.deepEqual(DesktopWindowCapture.windowCaptureFlashBounds(undefined), {
    x: 0,
    y: 0,
    width: 1_440,
    height: 900,
  });
});

it("bounds source thumbnails for large windows", () => {
  assert.deepEqual(
    DesktopWindowCapture.windowCaptureThumbnailSize({
      bounds: { x: 0, y: 0, width: 6_000, height: 4_000 },
    } as Parameters<typeof DesktopWindowCapture.windowCaptureThumbnailSize>[0]),
    { width: 2_560, height: 1_600 },
  );
});

it("does not overlap accessibility reads after a timeout", async () => {
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
  } as Parameters<typeof DesktopWindowCapture.readAccessibleWindowText>[0];

  try {
    const first = DesktopWindowCapture.readAccessibleWindowText(active, "darwin", "main.ts");
    await started.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    assert.isUndefined(await first);
    assert.isUndefined(
      await DesktopWindowCapture.readAccessibleWindowText(active, "darwin", "main.ts"),
    );
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 1);

    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    accessibilityByPidMock.mockResolvedValueOnce({ children: async () => [] });
    assert.isUndefined(
      await DesktopWindowCapture.readAccessibleWindowText(active, "darwin", "main.ts"),
    );
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["darwin", "win32"] as const)(
  "uses native opacity for a short-lived flash on %s",
  async (platform) => {
    vi.useFakeTimers();
    flashWindows.length = 0;
    const flash = new DesktopWindowCapture.WindowCaptureFlash(platform);
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
  },
);

it("uses a short-lived renderer flash on Linux", async () => {
  vi.useFakeTimers();
  flashWindows.length = 0;
  const flash = new DesktopWindowCapture.WindowCaptureFlash("linux");

  try {
    await flash.showStatic({ x: 0, y: 0, width: 800, height: 600 });
    assert.strictEqual(flashWindows[0]?.options.transparent, true);
    assert.strictEqual(flashWindows[0]?.loadCount, 1);
    await vi.advanceTimersByTimeAsync(60);
    assert.isTrue(flashWindows[0]?.destroyed);
    assert.strictEqual(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

it.effect("does not create the flash window during desktop startup", () => {
  flashWindows.length = 0;
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
    }),
  ).pipe(Effect.provide(testLayer("darwin", {}, Option.some(settings))));
});

it.effect("starts the Shift listener outside the Electron main process", () => {
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
      assert.strictEqual(shortcutForkOptions[0]?.env?.ELECTRON_RUN_AS_NODE, "1");
      assert.strictEqual(uiohookMock.start.mock.calls.length, 0);

      shortcutProcesses[0]?.emit("exit", 1);
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      assert.isFalse((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("linux")));
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
  ).pipe(Effect.provide(testLayer("linux")));
});

it.effect("rejects unavailable Wayland shortcuts before saving", () => {
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
      const unavailable = yield* service.checkShortcut({
        key: "9",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        modKey: false,
      });
      assert.isFalse(conflict.available);
      assert.isFalse(unavailable.available);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("applies concurrent settings changes in order while permissions are pending", () => {
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
      const enableFiber = yield* service.configure(enabled).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      if (!finishPermissionRequest) throw new Error("Permission request did not start");
      const finishPermission = finishPermissionRequest;

      const disableFiber = yield* service
        .configure({ ...enabled, windowCaptureEnabled: false })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      finishPermission();
      yield* Fiber.join(enableFiber);
      yield* Fiber.join(disableFiber);

      const state = yield* service.state;
      assert.isFalse(state.shortcutRegistered);
      assert.isNull(state.message);
    }),
  ).pipe(Effect.provide(layer));
});
