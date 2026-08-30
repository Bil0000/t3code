import { assert, expect, it } from "vite-plus/test";

import {
  createRecordingRequestTracker,
  windowCaptureSoundPatch,
} from "./WindowCaptureSettings.logic";

it.each([
  ["off", { windowCapturePlaySound: false }],
  ["soft-pop", { windowCapturePlaySound: true, windowCaptureSound: "soft-pop" }],
  ["camera-shutter", { windowCapturePlaySound: true, windowCaptureSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(windowCaptureSoundPatch(sound)).toEqual(patch);
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
