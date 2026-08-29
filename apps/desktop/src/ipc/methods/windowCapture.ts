import {
  DesktopPendingWindowCapture,
  DesktopWindowCapture as DesktopWindowCaptureSchema,
  DesktopWindowCaptureId,
  DesktopWindowCaptureShortcutAvailability,
  DesktopWindowCaptureState,
  WindowCaptureShortcut,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowCapture from "../../windowCapture/DesktopWindowCapture.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ensureTrustedWindowCaptureSender = Effect.fn("desktop.ipc.windowCapture.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new DesktopWindowCapture.DesktopWindowCaptureError({
        operation: "unauthorized",
      });
    }
  },
);

export const getWindowCaptureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_WINDOW_CAPTURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowCaptureState,
  handler: Effect.fn("desktop.ipc.windowCapture.getState")(function* () {
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).state;
  }),
});

export const checkWindowCaptureShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_WINDOW_CAPTURE_SHORTCUT_CHANNEL,
  payload: WindowCaptureShortcut,
  result: DesktopWindowCaptureShortcutAvailability,
  handler: Effect.fn("desktop.ipc.windowCapture.checkShortcut")(function* (shortcut, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).checkShortcut(shortcut);
  }),
});

export const setWindowCaptureShortcutSuppressed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_WINDOW_CAPTURE_SHORTCUT_SUPPRESSED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.setShortcutSuppressed")(
    function* (suppressed, event) {
      yield* ensureTrustedWindowCaptureSender(event);
      yield* (yield* DesktopWindowCapture.DesktopWindowCapture).setShortcutSuppressed(suppressed);
    },
  ),
});

export const captureWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CAPTURE_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.capture")(function* (_, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).captureNow;
  }),
});

export const listPendingWindowCaptures = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PENDING_WINDOW_CAPTURES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPendingWindowCapture),
  handler: Effect.fn("desktop.ipc.windowCapture.listPending")(function* (_, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).listPending;
  }),
});

export const readWindowCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_WINDOW_CAPTURE_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: DesktopWindowCaptureSchema,
  handler: Effect.fn("desktop.ipc.windowCapture.read")(function* (id, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).read(id);
  }),
});

export const acknowledgeWindowCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACKNOWLEDGE_WINDOW_CAPTURE_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.acknowledge")(function* (id, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).acknowledge(id);
  }),
});
