import type { ClientSettingsPatch, WindowCaptureSound } from "@t3tools/contracts";

export type WindowCaptureSoundSelection = WindowCaptureSound | "off";

export function windowCaptureSoundPatch(sound: WindowCaptureSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { windowCapturePlaySound: false }
    : { windowCapturePlaySound: true, windowCaptureSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
