import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { playWindowCaptureSound } from "./windowCaptureSound";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Audio");
  Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("playWindowCaptureSound", () => {
  it("plays the upward foley pop from its first sample", () => {
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

    playWindowCaptureSound("soft-pop");

    expect(AudioMock).toHaveBeenCalledWith(expect.stringMatching(/window-capture-up-pop\.wav/));
    expect(sound.preload).toBe("auto");
    expect(sound.currentTime).toBe(0);
    expect(sound.play).toHaveBeenCalledOnce();
  });

  it("closes the camera shutter context when resume is blocked", async () => {
    const context = {
      close: vi.fn().mockResolvedValue(undefined),
      createBuffer: vi.fn(),
      resume: vi.fn().mockRejectedValue(new Error("blocked")),
    };
    function AudioContextMock() {
      return context;
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: AudioContextMock },
    });

    playWindowCaptureSound("camera-shutter");

    await vi.waitFor(() => expect(context.close).toHaveBeenCalledOnce());

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.createBuffer).not.toHaveBeenCalled();
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
