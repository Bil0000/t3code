import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { playWindowCaptureSound } from "./windowCaptureSound";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Audio");
  vi.restoreAllMocks();
});

describe("playWindowCaptureSound", () => {
  it.each([
    ["soft-pop", /window-capture-whoosh\.mp3/],
    ["camera-shutter", /window-capture-click\.mp3/],
  ] as const)("plays the %s sound from its first sample", (selection, expectedUrl) => {
    const sound = {
      currentTime: 3,
      play: vi.fn().mockResolvedValue(undefined),
      preload: "none",
    };
    const AudioMock = vi.fn(function AudioMock() {
      return sound;
    });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: AudioMock,
    });

    playWindowCaptureSound(selection);

    expect(AudioMock).toHaveBeenCalledWith(expect.stringMatching(expectedUrl));
    expect(sound.preload).toBe("auto");
    expect(sound.currentTime).toBe(0);
    expect(sound.play).toHaveBeenCalledOnce();
  });
  it("ignores blocked playback", async () => {
    const sound = {
      currentTime: 0,
      play: vi.fn().mockRejectedValue(new Error("blocked")),
      preload: "none",
    };
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: vi.fn(function AudioMock() {
        return sound;
      }),
    });

    expect(() => playWindowCaptureSound("soft-pop")).not.toThrow();
    await vi.waitFor(() => expect(sound.play).toHaveBeenCalledOnce());
  });
});
