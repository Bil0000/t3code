import { effectiveWindowCaptureShortcut } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MODIFIER_PAIR_IDLE,
  UIOHOOK_MODIFIER_KEYCODES,
  accessibleWindowText,
  findAccessibleWindow,
  findAccessibleWindowByTitle,
  findCaptureSource,
  hideAndWaitForBlur,
  isPortalWindowSourceName,
  isWaylandSession,
  shouldRequestScreenCapturePermission,
  updateModifierPair,
  windowCaptureShortcutRegistrationFailureMessage,
  windowCaptureShortcutSystemConflict,
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

describe("effectiveWindowCaptureShortcut", () => {
  it("keeps Shift + Shift for direct capture and uses an Electron chord on Wayland", () => {
    const shortcut = { kind: "both-shift-keys" } as const;
    expect(effectiveWindowCaptureShortcut("direct", shortcut)).toBe(shortcut);
    expect(effectiveWindowCaptureShortcut("portal", shortcut)).toEqual({
      key: "2",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
  });

  it("rewrites any modifier pair to the Wayland chord on portal capture", () => {
    const shortcut = { kind: "modifier-pair", modifier: "meta" } as const;
    expect(effectiveWindowCaptureShortcut("direct", shortcut)).toBe(shortcut);
    expect(effectiveWindowCaptureShortcut("portal", shortcut)).toEqual({
      key: "2",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
  });
});

describe("portal window matching", () => {
  it("rejects generic portal source names", () => {
    expect(isPortalWindowSourceName("Entire screen")).toBe(false);
    expect(isPortalWindowSourceName("Screen 1")).toBe(false);
    expect(isPortalWindowSourceName("  ")).toBe(false);
    expect(isPortalWindowSourceName("main.ts — Editor")).toBe(true);
  });

  it("matches a picked window only when its title is unique", () => {
    const windows = [
      { appName: "Editor", window: { name: "main.ts — Editor" } },
      { appName: "Browser", window: { name: "Docs" } },
    ];
    expect(findAccessibleWindowByTitle(windows, " main.ts — Editor ")).toBe(windows[0]);
    expect(findAccessibleWindowByTitle(windows, "missing")).toBeUndefined();
    expect(
      findAccessibleWindowByTitle(
        [...windows, { appName: "Other", window: { name: "Docs" } }],
        "Docs",
      ),
    ).toBeUndefined();
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

  // The live-socket check reads /proc/net/unix, which only exists on Linux.
  it.skipIf(process.platform !== "linux")(
    "falls back to a live runtime directory socket when session variables are stripped",
    async () => {
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { createServer } = await import("node:net");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const runtimeDirectory = await mkdtemp(join(tmpdir(), "t3-wayland-"));
      const socketPath = join(runtimeDirectory, "wayland-0");
      const server = createServer();
      try {
        expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(false);
        await writeFile(socketPath, "");
        expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(false);
        await rm(socketPath);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(true);
        expect(
          isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory, XDG_SESSION_TYPE: "x11" }),
        ).toBe(false);
        expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: "/nonexistent-t3-test" })).toBe(false);
      } finally {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
        await rm(runtimeDirectory, { recursive: true, force: true });
      }
    },
  );
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
describe("modifier pairs", () => {
  it("fires once when both physical Shift keys are held", () => {
    const pair = UIOHOOK_MODIFIER_KEYCODES.shift;
    const left = updateModifierPair(MODIFIER_PAIR_IDLE, pair, 42, true);
    expect(left.triggered).toBe(false);

    const both = updateModifierPair(left.state, pair, 54, true);
    expect(both.triggered).toBe(true);
    expect(updateModifierPair(both.state, pair, 54, true).triggered).toBe(false);

    const released = updateModifierPair(both.state, pair, 42, false);
    expect(updateModifierPair(released.state, pair, 42, true).triggered).toBe(true);
  });

  it("fires for both physical Command keys", () => {
    const pair = UIOHOOK_MODIFIER_KEYCODES.meta;
    const left = updateModifierPair(MODIFIER_PAIR_IDLE, pair, 3_675, true);
    expect(left.triggered).toBe(false);
    expect(updateModifierPair(left.state, pair, 3_676, true).triggered).toBe(true);
  });

  it("ignores other keys", () => {
    expect(
      updateModifierPair(MODIFIER_PAIR_IDLE, UIOHOOK_MODIFIER_KEYCODES.shift, 30, true),
    ).toEqual({
      state: MODIFIER_PAIR_IDLE,
      triggered: false,
    });
  });
});

describe("windowCaptureShortcutRegistrationFailureMessage", () => {
  it("distinguishes a modifier listener failure from a reserved key chord", () => {
    expect(
      windowCaptureShortcutRegistrationFailureMessage({ kind: "both-shift-keys" }, "darwin"),
    ).toMatch(/Shift \+ Shift is not available/);
    expect(
      windowCaptureShortcutRegistrationFailureMessage(
        { kind: "modifier-pair", modifier: "meta" },
        "darwin",
      ),
    ).toMatch(/Command \+ Command is not available/);
    expect(
      windowCaptureShortcutRegistrationFailureMessage(
        { kind: "modifier-pair", modifier: "meta" },
        "linux",
      ),
    ).toMatch(/Super \+ Super is not available/);
    expect(
      windowCaptureShortcutRegistrationFailureMessage(
        {
          key: "2",
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          modKey: true,
        },
        "darwin",
      ),
    ).toMatch(/already used/);
  });
});

describe("windowCaptureShortcutSystemConflict", () => {
  it("blocks shortcuts that would break typing or common app actions", () => {
    expect(
      windowCaptureShortcutSystemConflict({
        key: "s",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: false,
      }),
    ).toMatch(/typing/);
    expect(
      windowCaptureShortcutSystemConflict({
        key: "c",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      }),
    ).toMatch(/Copy/);
  });

  it("allows a specific multi-modifier shortcut", () => {
    expect(
      windowCaptureShortcutSystemConflict({
        key: "2",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    ).toBeNull();
  });
});
