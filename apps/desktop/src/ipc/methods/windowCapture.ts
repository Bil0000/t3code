import {
  DesktopPendingWindowCapture,
  DesktopWindowCapture as DesktopWindowCaptureSchema,
  DesktopWindowCaptureAnimationDestination,
  DesktopWindowCaptureId,
  DesktopWindowCaptureShortcutAvailability,
  DesktopWindowCaptureState,
  DesktopWindowCaptureSetupAction,
  WindowCaptureShortcut,
  DesktopCaptureConfigRequest,
  DesktopCaptureConfigPreview,
  DesktopCaptureConfigApplied,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopWindowCapture from "../../windowCapture/DesktopWindowCapture.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class WindowCaptureIpcUnauthorizedSenderError extends Schema.TaggedErrorClass<WindowCaptureIpcUnauthorizedSenderError>()(
  "WindowCaptureIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Snapshot request was rejected.";
  }
}

const ensureTrustedWindowCaptureSender = Effect.fn("desktop.ipc.windowCapture.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new WindowCaptureIpcUnauthorizedSenderError();
    }
    return main.value;
  },
);

export function windowCaptureScreenFrame(
  viewportFrame: DesktopWindowCaptureAnimationDestination["viewportFrame"],
  contentBounds: Electron.Rectangle,
  zoomFactor: number,
): Electron.Rectangle {
  return {
    x: contentBounds.x + viewportFrame.x * zoomFactor,
    y: contentBounds.y + viewportFrame.y * zoomFactor,
    width: viewportFrame.width * zoomFactor,
    height: viewportFrame.height * zoomFactor,
  };
}

export function windowCaptureRelativeFrame(
  frame: DesktopWindowCaptureAnimationDestination["viewportFrame"],
  bounds: Electron.Rectangle,
  zoom: number,
): Electron.Rectangle | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    x: (frame.x * zoom) / bounds.width,
    y: (frame.y * zoom) / bounds.height,
    width: (frame.width * zoom) / bounds.width,
    height: (frame.height * zoom) / bounds.height,
  };
}

export const getWindowCaptureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_WINDOW_CAPTURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowCaptureState,
  handler: Effect.fn("desktop.ipc.windowCapture.getState")(function* () {
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).state;
  }),
});

export const requestWindowCapturePermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_WINDOW_CAPTURE_PERMISSIONS_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.requestPermissions")(
    function* (includeAccessibility, event) {
      yield* ensureTrustedWindowCaptureSender(event);
      yield* (yield* DesktopWindowCapture.DesktopWindowCapture).requestPermissions(
        includeAccessibility,
      );
    },
  ),
});

export const setupWindowCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SETUP_WINDOW_CAPTURE_CHANNEL,
  payload: DesktopWindowCaptureSetupAction,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.setup")(function* (action, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).setup(action);
  }),
});

export const previewWindowCaptureConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_WINDOW_CAPTURE_CONFIG_CHANNEL,
  payload: DesktopCaptureConfigRequest,
  result: Schema.NullOr(DesktopCaptureConfigPreview),
  handler: Effect.fn("desktop.ipc.windowCapture.previewConfig")(function* (request, event) {
    const window = yield* ensureTrustedWindowCaptureSender(event);
    const capture = yield* DesktopWindowCapture.DesktopWindowCapture;
    let selectedPath: string | undefined;
    if (request.chooseFile) {
      const state = yield* capture.state;
      const paths = yield* (yield* ElectronDialog.ElectronDialog).pickFiles({
        owner: Option.some(window),
        defaultPath: Option.fromUndefinedOr(state.shortcutConfigPath),
        filters: [
          {
            name: "Desktop config",
            extensions: state.linuxBackend === "niri" ? ["kdl"] : ["conf", "lua"],
          },
        ],
        multiple: false,
      });
      selectedPath = paths[0];
      if (!selectedPath) return null;
    }
    return yield* capture.previewConfig(request, selectedPath);
  }),
});

export const applyWindowCaptureConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLY_WINDOW_CAPTURE_CONFIG_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: DesktopCaptureConfigApplied,
  handler: Effect.fn("desktop.ipc.windowCapture.applyConfig")(function* (id, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    return yield* (yield* DesktopWindowCapture.DesktopWindowCapture).applyConfig(id);
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

export const setWindowCaptureAnimationDestination = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_WINDOW_CAPTURE_ANIMATION_DESTINATION_CHANNEL,
  payload: DesktopWindowCaptureAnimationDestination,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.setAnimationDestination")(
    function* (destination, event) {
      const window = yield* ensureTrustedWindowCaptureSender(event);
      if (
        destination.viewportFrame.width <= 0 ||
        destination.viewportFrame.height <= 0 ||
        destination.borderWidth < 0 ||
        destination.cornerRadius < 0
      ) {
        return;
      }
      yield* (yield* DesktopWindowCapture.DesktopWindowCapture).setAnimationDestination(
        destination.id,
        {
          relativeFrame: windowCaptureRelativeFrame(
            destination.viewportFrame,
            window.getContentBounds(),
            window.webContents.getZoomFactor(),
          ),
          frame: windowCaptureScreenFrame(
            destination.viewportFrame,
            window.getContentBounds(),
            window.webContents.getZoomFactor(),
          ),
          backgroundColor: destination.backgroundColor,
          borderColor: destination.borderColor,
          borderWidth: destination.borderWidth * window.webContents.getZoomFactor(),
          cornerRadius: destination.cornerRadius * window.webContents.getZoomFactor(),
          scaleFactor: window.webContents.getZoomFactor(),
          details: destination.details,
        },
      );
    },
  ),
});

export const dismissWindowCaptureAnimation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISMISS_WINDOW_CAPTURE_ANIMATION_CHANNEL,
  payload: DesktopWindowCaptureId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowCapture.dismissAnimation")(function* (id, event) {
    yield* ensureTrustedWindowCaptureSender(event);
    yield* (yield* DesktopWindowCapture.DesktopWindowCapture).dismissAnimation(id);
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
