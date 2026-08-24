import { describe, expect, it } from "vite-plus/test";

import { findCaptureSource, isWaylandSession, toElectronAccelerator } from "./windowCapture.ts";

describe("toElectronAccelerator", () => {
  it("converts the default portable shortcut", () => {
    expect(
      toElectronAccelerator({
        key: "2",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    ).toBe("CommandOrControl+Shift+2");
  });

  it("normalizes Electron key names", () => {
    expect(
      toElectronAccelerator({
        key: "ArrowUp",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: true,
        modKey: false,
      }),
    ).toBe("Control+Alt+Up");
  });
});

describe("findCaptureSource", () => {
  const sources = [
    { id: "window:42:0", name: "Terminal" },
    { id: "window:84:0", name: "Editor" },
  ];

  it("matches the native window id before its title", () => {
    expect(
      findCaptureSource(sources, {
        id: 84,
        title: "Changed title",
      }),
    ).toEqual(sources[1]);
  });

  it("falls back to a unique title match", () => {
    expect(
      findCaptureSource(sources, {
        id: 100,
        title: "Terminal",
      }),
    ).toEqual(sources[0]);
  });

  it("does not guess when a title is ambiguous", () => {
    expect(
      findCaptureSource(
        [
          { id: "window:42:0", name: "Editor" },
          { id: "window:84:0", name: "Editor" },
        ],
        {
          id: 100,
          title: "Editor",
        },
      ),
    ).toBeUndefined();
  });
});

describe("isWaylandSession", () => {
  it.each([
    ["linux", { XDG_SESSION_TYPE: "wayland" }, true],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["linux", { XDG_SESSION_TYPE: "x11" }, false],
    ["darwin", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, false],
  ] as const)("detects %s session %o as portal=%s", (platform, environment, expected) => {
    expect(isWaylandSession(platform, environment)).toBe(expected);
  });
});
