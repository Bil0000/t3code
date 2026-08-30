import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { playWindowCaptureSound } from "./windowCaptureSound";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("playWindowCaptureSound", () => {
  it("closes the audio context when it cannot resume", async () => {
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
      value: {
        AudioContext: AudioContextMock,
      },
    });

    playWindowCaptureSound();
    await vi.waitFor(() => expect(context.close).toHaveBeenCalledOnce());

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.createBuffer).not.toHaveBeenCalled();
  });
});
