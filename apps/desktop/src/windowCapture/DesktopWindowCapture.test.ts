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
  getSourcesMock,
  openExternalMock,
  registerShortcutMock,
} = vi.hoisted(() => ({
  accessibilityByPidMock: vi.fn(),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    loadCount: number;
    scripts: Array<string>;
    showCount: number;
  }>,
  getSourcesMock: vi.fn(),
  openExternalMock: vi.fn(() => Promise.resolve()),
  registerShortcutMock: vi.fn(),
}));

vi.mock("@crowecawcaw/xa11y", () => ({ App: { byPid: accessibilityByPidMock } }));

vi.mock("electron", () => ({
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }

    readonly webContents;
    private readonly state: (typeof flashWindows)[number];

    constructor() {
      this.state = {
        bounds: null,
        destroyed: false,
        loadCount: 0,
        scripts: [],
        showCount: 0,
      };
      flashWindows.push(this.state);
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
        },
      };
    }

    destroy() {
      this.state.destroyed = true;
    }

    hide() {}

    isDestroyed() {
      return this.state.destroyed;
    }

    loadURL() {
      this.state.loadCount += 1;
      return Promise.resolve();
    }

    setBounds(bounds: Electron.Rectangle) {
      this.state.bounds = bounds;
    }

    setIgnoreMouseEvents() {}

    showInactive() {
      this.state.showCount += 1;
    }
  },
  desktopCapturer: { getSources: getSourcesMock },
  globalShortcut: { register: registerShortcutMock, unregister: vi.fn() },
  shell: { openExternal: openExternalMock },
  systemPreferences: {
    getMediaAccessStatus: () => "not-determined",
    isTrustedAccessibilityClient: () => true,
  },
}));

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
      DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
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

it("reuses one flash window and disposes it after playback", async () => {
  vi.useFakeTimers();
  flashWindows.length = 0;
  const flash = new DesktopWindowCapture.WindowCaptureFlash();
  const bounds = { x: 10, y: 20, width: 800, height: 600 };

  try {
    await flash.prepare();
    await flash.showAnimated(bounds);
    await flash.showStatic(bounds);

    assert.lengthOf(flashWindows, 1);
    assert.strictEqual(flashWindows[0]?.loadCount, 1);
    assert.deepEqual(flashWindows[0]?.bounds, bounds);
    assert.strictEqual(flashWindows[0]?.showCount, 2);
    assert.lengthOf(flashWindows[0]?.scripts ?? [], 2);
    await vi.advanceTimersByTimeAsync(60);
    assert.isTrue(flashWindows[0]?.destroyed);
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
