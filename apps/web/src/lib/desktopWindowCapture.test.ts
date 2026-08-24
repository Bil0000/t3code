import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getDesktopWindowCaptureBridge } from "./desktopWindowCapture";

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("getDesktopWindowCaptureBridge", () => {
  it("rejects an older desktop bridge without window capture methods", () => {
    window.desktopBridge = {} as DesktopBridge;

    expect(getDesktopWindowCaptureBridge()).toBeUndefined();
  });

  it("returns a bridge with the complete window capture capability", () => {
    const bridge = {
      getWindowCaptureState: vi.fn(),
      captureWindow: vi.fn(),
      listPendingWindowCaptures: vi.fn(),
      readWindowCapture: vi.fn(),
      acknowledgeWindowCapture: vi.fn(),
    } as unknown as DesktopBridge;
    window.desktopBridge = bridge;

    expect(getDesktopWindowCaptureBridge()).toBe(bridge);
  });
});
