import { describe, expect, it, vi } from "vite-plus/test";

import {
  accessibleWindowText,
  findAccessibleWindow,
  findCaptureSource,
  hideAndWaitForBlur,
  isWaylandSession,
  shouldRequestScreenCapturePermission,
  toElectronAccelerator,
} from "./windowCapture.ts";
import {
  DesktopWindowCaptureDisabledError,
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
    expect(new DesktopWindowCaptureDisabledError().message).toBe(
      "Enable Window Capture in Settings first.",
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

  it("stops traversing very large trees", () => {
    expect(
      accessibleWindowText(
        {
          children: [
            ...Array.from({ length: 10_000 }, () => ({ children: [] })),
            { value: "past node limit", children: [] },
          ],
        },
        100,
      ),
    ).not.toContain("past node limit");
  });
});

describe("findAccessibleWindow", () => {
  const captured = {
    title: "Editor",
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  };

  it("matches one window by its captured bounds", () => {
    const windows = [
      { name: "Private", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      { name: "Editor", bounds: { x: 101, y: 199, width: 800, height: 601 } },
    ];

    expect(findAccessibleWindow(windows, captured)).toBe(windows[1]);
  });

  it("uses the matched source title when macOS omits the active title", () => {
    const windows = [{ name: "Editor", bounds: captured.bounds }];
    expect(
      findAccessibleWindow(windows, {
        ...captured,
        title: "",
        sourceTitle: "Editor",
      }),
    ).toBe(windows[0]);
  });

  it("does not match equal bounds with a different title", () => {
    expect(
      findAccessibleWindow(
        [{ name: "Private", bounds: { x: 100, y: 200, width: 800, height: 600 } }],
        captured,
      ),
    ).toBeUndefined();
  });

  it("does not use a title match when the bounds differ", () => {
    expect(
      findAccessibleWindow(
        [{ name: "Editor", bounds: { x: 0, y: 0, width: 800, height: 600 } }],
        captured,
      ),
    ).toBeUndefined();
  });
});

describe("hideAndWaitForBlur", () => {
  it("waits for a delayed blur after hiding the window", async () => {
    let blur: (() => void) | undefined;
    let settled = false;
    const hidden = hideAndWaitForBlur({
      hide: () => undefined,
      once: (_event, listener) => {
        blur = listener;
      },
      removeListener: () => undefined,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    blur?.();
    await hidden;
    expect(settled).toBe(true);
  });

  it("rejects when the hidden window never blurs", async () => {
    vi.useFakeTimers();
    try {
      let rejected = false;
      const hidden = hideAndWaitForBlur({
        hide: () => undefined,
        once: () => undefined,
        removeListener: () => undefined,
      }).catch(() => {
        rejected = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejected).toBe(true);
      await hidden;
    } finally {
      vi.useRealTimers();
    }
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

  it("maps the portable meta key to Super", () => {
    expect(
      toElectronAccelerator({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: false,
      }),
    ).toBe("Super+K");
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
