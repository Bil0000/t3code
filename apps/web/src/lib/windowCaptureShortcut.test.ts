import { effectiveWindowCaptureShortcut } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatWindowCaptureShortcutLabel,
  sameWindowCaptureShortcut,
  windowCaptureKeybindingConflict,
} from "./windowCaptureShortcut";

describe("window capture shortcut labels", () => {
  it("labels the default physical Shift pair", () => {
    expect(formatWindowCaptureShortcutLabel({ kind: "both-shift-keys" }, "MacIntel")).toBe(
      "Shift + Shift",
    );
  });
});

describe("window capture keybinding conflicts", () => {
  it("finds an effective T3 Code keybinding on the current platform", () => {
    expect(
      windowCaptureKeybindingConflict(
        {
          key: "n",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        [
          {
            command: "chat.new",
            shortcut: {
              key: "n",
              metaKey: true,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
          },
        ],
        "MacIntel",
      ),
    ).toBe("chat.new");
  });

  it("does not conflict with regular keybindings for both Shift keys", () => {
    expect(windowCaptureKeybindingConflict({ kind: "both-shift-keys" }, [], "Linux")).toBeNull();
  });

  it("finds a conflict for the effective Wayland Shift shortcut", () => {
    const shortcut = effectiveWindowCaptureShortcut("portal", { kind: "both-shift-keys" });

    expect(
      windowCaptureKeybindingConflict(
        shortcut,
        [
          {
            command: "capture.other",
            shortcut: {
              key: "2",
              metaKey: false,
              ctrlKey: false,
              shiftKey: true,
              altKey: false,
              modKey: true,
            },
          },
        ],
        "Linux",
      ),
    ).toBe("capture.other");
  });
});

describe("sameWindowCaptureShortcut", () => {
  it("compares the physical Shift pair and platform-equivalent chords", () => {
    expect(
      sameWindowCaptureShortcut(
        { kind: "both-shift-keys" },
        { kind: "both-shift-keys" },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      sameWindowCaptureShortcut(
        { key: "n", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true },
        { key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, modKey: false },
        "MacIntel",
      ),
    ).toBe(true);
  });
});
