import { describe, expect, it } from "vite-plus/test";

import {
  accessibleWindowText,
  findCaptureSource,
  isWaylandSession,
  shouldRequestScreenCapturePermission,
  toElectronAccelerator,
} from "./windowCapture.ts";
import {
  DesktopWindowCaptureFailedError,
  DesktopWindowCaptureNoWindowSelectedError,
  DesktopWindowCaptureUnsupportedError,
  DesktopWindowCaptureWindowUnavailableError,
} from "./DesktopWindowCapture.ts";

describe("window capture errors", () => {
  it("keeps each user-facing capture failure distinct", () => {
    const captureId = "capture-id";
    expect(new DesktopWindowCaptureUnsupportedError({ captureId }).message).toBe(
      "Window capture is not supported here.",
    );
    expect(new DesktopWindowCaptureNoWindowSelectedError({ captureId }).message).toBe(
      "No window was selected.",
    );
    expect(new DesktopWindowCaptureWindowUnavailableError({ captureId }).message).toBe(
      "The active window is not available for capture.",
    );
    expect(
      new DesktopWindowCaptureFailedError({ captureId, cause: new Error("native failure") })
        .message,
    ).toBe("Could not capture the active window.");
  });
});

describe("accessibleWindowText", () => {
  it("keeps unique names and values in tree order", () => {
    expect(
      accessibleWindowText(
        {
          name: "Settings",
          children: [
            {
              name: "General",
              children: [],
            },
            {
              name: "Name",
              value: "Bilal",
              children: [],
            },
          ],
        },
        100,
      ),
    ).toBe("Settings\nGeneral\nName\nBilal");
  });

  it("caps large text without splitting a surrogate pair", () => {
    expect(
      accessibleWindowText(
        {
          value: "abc😀def",
          children: [],
        },
        5,
      ),
    ).toBe("abc😀");
  });
});

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

describe("shouldRequestScreenCapturePermission", () => {
  it.each([
    ["darwin", false, true, true],
    ["darwin", true, true, false],
    ["darwin", true, false, false],
    ["win32", false, true, false],
  ] as const)("returns %s %s → %s as %s", (platform, previous, enabled, expected) => {
    expect(shouldRequestScreenCapturePermission(platform, previous, enabled)).toBe(expected);
  });
});
