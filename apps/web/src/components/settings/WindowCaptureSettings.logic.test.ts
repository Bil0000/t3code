import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopWindowCaptureState } from "@t3tools/contracts";

import {
  createRecordingRequestTracker,
  windowCaptureStatus,
  windowCaptureUnavailableMessage,
  windowCaptureSoundPatch,
  windowCaptureFeedbackUnavailableMessage,
} from "./WindowCaptureSettings.logic";

it.each([
  ["off", { windowCapturePlaySound: false }],
  ["soft-pop", { windowCapturePlaySound: true, windowCaptureSound: "soft-pop" }],
  ["camera-shutter", { windowCapturePlaySound: true, windowCaptureSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(windowCaptureSoundPatch(sound)).toEqual(patch);
});

it("offers effects only with a capable GNOME extension, explaining how to upgrade v1", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  expect(windowCaptureFeedbackUnavailableMessage(state)).toContain("Update");
  expect(
    windowCaptureFeedbackUnavailableMessage({ ...state, linuxFeedbackAvailable: true }),
  ).toBeUndefined();
  expect(windowCaptureFeedbackUnavailableMessage({ ...state, linuxBackend: "picker" })).toContain(
    "require",
  );
  expect(windowCaptureFeedbackUnavailableMessage({ ...state, mode: "direct" })).toBeUndefined();
});

it("ignores a stale request after a newer request starts", () => {
  const requests = createRecordingRequestTracker();
  const firstRequest = requests.tryBegin();
  assert(firstRequest);

  requests.clear();
  const secondRequest = requests.tryBegin();
  assert(secondRequest);

  expect(requests.owns(firstRequest)).toBe(false);
  expect(requests.owns(secondRequest)).toBe(true);
  expect(requests.tryBegin()).toBeNull();
});

it("reports unavailable capture support without browser globals", () => {
  expect(windowCaptureUnavailableMessage(false)).toBe("Only available in the desktop app.");
});

it.each([
  ["screenshot-portal", "Screenshot portal"],
  ["gnome-extension", "GNOME extension"],
  ["picker", "window picker"],
  [undefined, "could not be checked"],
] as const)("reports the actual Linux capture backend %s", (linuxBackend, message) => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend,
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: true,
    shortcutMessage: "Requested",
    message: null,
  };
  expect(windowCaptureStatus(state, true)).toContain(message);
  expect(windowCaptureStatus({ ...state, message: "Capture failed" }, true)).toBe("Capture failed");
});
