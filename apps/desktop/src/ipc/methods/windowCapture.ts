import {
  DesktopPendingWindowCapture,
  DesktopWindowCapture as DesktopWindowCaptureSchema,
  DesktopWindowCaptureId,
  DesktopWindowCaptureState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindowCapture from "../../windowCapture/DesktopWindowCapture.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getWindowCaptureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_WINDOW_CAPTURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowCaptureState,
  handler: Effect.fn("desktop.ipc.windowCapture.getState")(function* () {
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).state;
  }),
});

export const captureWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CAPTURE_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.capture")(function* () {
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).capture;
  }),
});

export const listPendingWindowCaptures = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PENDING_WINDOW_CAPTURES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPendingWindowCapture),
  handler: Effect.fn("desktop.ipc.windowCapture.listPending")(function* () {
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).listPending;
  }),
});

export const readWindowCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_WINDOW_CAPTURE_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: DesktopWindowCaptureSchema,
  handler: Effect.fn("desktop.ipc.windowCapture.read")(function* (id) {
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).read(id);
  }),
});

export const acknowledgeWindowCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACKNOWLEDGE_WINDOW_CAPTURE_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.acknowledge")(function* (id) {
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).acknowledge(id);
  }),
});
