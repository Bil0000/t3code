import { assert, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

const { getSourcesMock, openExternalMock } = vi.hoisted(() => ({
  getSourcesMock: vi.fn(),
  openExternalMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: getSourcesMock },
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
        get: Effect.succeed(Option.none()),
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
