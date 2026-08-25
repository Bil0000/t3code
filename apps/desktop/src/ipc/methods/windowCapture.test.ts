import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowCapture from "../../windowCapture/DesktopWindowCapture.ts";
import {
  captureWindow,
  checkWindowCaptureShortcut,
  setWindowCaptureShortcutSuppressed,
} from "./windowCapture.ts";

describe("window capture IPC", () => {
  it.effect("uses the manual capture path for a trusted renderer", () => {
    let globalCaptures = 0;
    let manualCaptures = 0;
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopWindowCapture.DesktopWindowCapture,
        DesktopWindowCapture.DesktopWindowCapture.of({
          capture: Effect.sync(() => {
            globalCaptures += 1;
          }),
          captureNow: Effect.sync(() => {
            manualCaptures += 1;
          }),
        } as unknown as DesktopWindowCapture.DesktopWindowCapture["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* captureWindow.handler(undefined, { sender: { id: 7 } });
      assert.strictEqual(globalCaptures, 0);
      assert.strictEqual(manualCaptures, 1);
    }).pipe(Effect.provide(layer));
  });
  it.effect("checks shortcut availability for a trusted renderer", () => {
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopWindowCapture.DesktopWindowCapture,
        DesktopWindowCapture.DesktopWindowCapture.of({
          checkShortcut: () => Effect.succeed({ available: true, message: null }),
        } as unknown as DesktopWindowCapture.DesktopWindowCapture["Service"]),
      ),
    );

    return Effect.gen(function* () {
      const result = yield* checkWindowCaptureShortcut.handler(
        { kind: "both-shift-keys" },
        { sender: { id: 7 } },
      );
      assert.deepEqual(result, { available: true, message: null });
    }).pipe(Effect.provide(layer));
  });
  it.effect("suppresses the active shortcut for a trusted renderer", () => {
    let suppressed = false;
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopWindowCapture.DesktopWindowCapture,
        DesktopWindowCapture.DesktopWindowCapture.of({
          setShortcutSuppressed: (next: boolean) =>
            Effect.sync(() => {
              suppressed = next;
            }),
        } as unknown as DesktopWindowCapture.DesktopWindowCapture["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* setWindowCaptureShortcutSuppressed.handler(true, { sender: { id: 7 } });
      assert.isTrue(suppressed);
    }).pipe(Effect.provide(layer));
  });
});
