import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopWindowCaptureState } from "@t3tools/contracts";

import {
  createRecordingRequestTracker,
  windowCaptureStatus,
  windowCaptureShortcutStatus,
  windowCaptureUnavailableMessage,
  windowCaptureSoundPatch,
  windowCaptureFeedbackUnavailableMessage,
  windowCaptureSetupSummary,
  windowCaptureSetupButtonLabel,
  windowCaptureDescription,
  windowCaptureAccessibilityUnavailableMessage,
} from "./WindowCaptureSettings.logic";

it.each([
  ["off", { windowCapturePlaySound: false }],
  ["soft-pop", { windowCapturePlaySound: true, windowCaptureSound: "soft-pop" }],
  ["camera-shutter", { windowCapturePlaySound: true, windowCaptureSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(windowCaptureSoundPatch(sound)).toEqual(patch);
});

it("offers effects only with a capable GNOME extension, explaining how to upgrade v1", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  expect(windowCaptureFeedbackUnavailableMessage(state)).toContain("Update");
  expect(
    windowCaptureFeedbackUnavailableMessage({ ...state, linuxFeedbackAvailable: true }),
  ).toBeUndefined();
  expect(windowCaptureFeedbackUnavailableMessage({ ...state, linuxBackend: "picker" })).toContain(
    "aren't available",
  );
  expect(windowCaptureFeedbackUnavailableMessage({ ...state, mode: "direct" })).toBeUndefined();
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

it("reports unavailable capture support without browser globals", () => {
  expect(windowCaptureUnavailableMessage(false)).toBe("Only available in the desktop app.");
});

it("describes Niri setup without claiming a global shortcut is registered", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "niri",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutMessage: "Managed by Niri",
    message: null,
  };
  expect(windowCaptureStatus(state, true)).toBe("Finish shortcut setup");
  expect(windowCaptureStatus(state, true)).not.toContain("could not be registered");
  expect(windowCaptureFeedbackUnavailableMessage(state)).toContain("aren't available on Niri");
});

it("distinguishes Hyprland helper setup, action registration, and verified shortcut delivery", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "hyprland",
    linuxDesktop: "hyprland",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutMessage: "Connecting to Hyprland shortcuts…",
    message: null,
    hyprlandHelper: { status: "not-installed", message: "Install helper" },
  };
  expect(windowCaptureSetupButtonLabel(state)).toBe("Set up Hyprland capture");
  expect(windowCaptureStatus(state, false)).toBe("Turn this on to set up window capture.");
  expect(windowCaptureStatus(state, true)).toContain("Install the capture helper");
  expect(windowCaptureFeedbackUnavailableMessage(state)).toContain("Install or update");
  const ready = {
    ...state,
    hyprlandHelper: { status: "ready" as const, message: "Ready" },
    linuxFeedbackAvailable: true,
  };
  expect(windowCaptureSetupButtonLabel(ready)).toBe("Manage capture");
  expect(windowCaptureShortcutStatus({ ...ready, shortcutPending: true })).not.toContain(
    "permission",
  );
  expect(windowCaptureStatus({ ...ready, shortcutActionRegistered: true }, true)).toBe(
    "Use your shortcut from another app",
  );
  expect(windowCaptureStatus({ ...ready, shortcutVerified: true }, true)).toBe("Ready to capture");
  expect(windowCaptureFeedbackUnavailableMessage(ready)).toBeUndefined();
  expect(windowCaptureAccessibilityUnavailableMessage(ready)).toBeUndefined();
});

it("keeps unavailable capture distinct from the opt-in setup prompt", () => {
  const state: DesktopWindowCaptureState = {
    mode: "unavailable",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutMessage: null,
    message: "Wayland is required.",
  };

  expect(windowCaptureStatus(state, false)).toBe("Wayland is required.");
});

it.each(["gnome-extension", "niri", "screenshot-portal", "picker"] as const)(
  "waits for opt-in before presenting %s setup requirements",
  (linuxBackend) => {
    const state: DesktopWindowCaptureState = {
      mode: "portal",
      linuxBackend,
      shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
      shortcutRegistered: false,
      shortcutMessage: "Shortcut permission needed",
      message: "Capture needs attention",
      gnomeExtension: { status: "not-installed", message: "Install the extension" },
    };

    expect(DEFAULT_CLIENT_SETTINGS.windowCaptureEnabled).toBe(false);
    expect(windowCaptureStatus(state, false)).toBe("Turn this on to set up window capture.");
    expect(windowCaptureStatus(state, true)).toBe("Capture needs attention");
  },
);

it("distinguishes saved shortcuts from observed delivery without making users repeat setup", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: true,
    shortcutMessage: "Requested",
    message: null,
    gnomeExtension: { status: "enabled", message: "Running" },
  };
  expect(windowCaptureSetupSummary(state, true)).toBe("Shortcut saved");
  expect(windowCaptureSetupButtonLabel(state)).toBe("Manage capture");
  expect(windowCaptureSetupSummary({ ...state, shortcutVerified: true }, true)).toBe(
    "Ready to capture",
  );
  expect(windowCaptureSetupButtonLabel({ ...state, shortcutVerified: true })).toBe(
    "Manage capture",
  );
  expect(windowCaptureSetupButtonLabel({ ...state, shortcutRegistered: false })).toBe(
    "Manage capture",
  );
  expect(
    windowCaptureSetupButtonLabel({
      ...state,
      gnomeExtension: { status: "disabled", message: "Enable the extension" },
    }),
  ).toBe("Set up GNOME capture");
  expect(windowCaptureSetupSummary({ ...state, shortcutVerified: true }, false)).toContain(
    "Enable capture",
  );
  expect(
    windowCaptureSetupSummary(
      {
        ...state,
        gnomeExtension: { status: "restart-required", message: "Sign out" },
        shortcutVerified: true,
      },
      true,
    ),
  ).toBe("Set up active-window capture");
  expect(
    windowCaptureSetupSummary(
      { ...state, linuxBackend: "niri", gnomeExtension: undefined, shortcutRegistered: false },
      true,
    ),
  ).toBe("Finish shortcut setup");
  expect(
    windowCaptureSetupSummary(
      { ...state, linuxBackend: "picker", gnomeExtension: undefined, shortcutVerified: true },
      true,
    ),
  ).toBe("Manual capture only — you'll choose a window each time");
  expect(
    windowCaptureSetupSummary(
      {
        ...state,
        linuxBackend: "screenshot-portal",
        gnomeExtension: { status: "not-installed", message: "Optional extension" },
        shortcutVerified: true,
      },
      true,
    ),
  ).toBe("Ready to capture");
});

it.each([
  ["gnome", "GNOME"],
  ["kde", "KDE Plasma"],
  ["niri", "Niri"],
] as const)(
  "names %s when setup cannot yet determine the capture backend",
  (linuxDesktop, name) => {
    const state: DesktopWindowCaptureState = {
      mode: "portal",
      linuxDesktop,
      shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message: "Capability check failed",
    };
    expect(windowCaptureSetupButtonLabel(state)).toBe(`Set up ${name} capture`);
  },
);

it("keeps picker limitations visible after shortcut verification without recommending a GNOME extension", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "picker",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
    shortcutVerified: true,
  };
  expect(windowCaptureStatus(state, true)).toContain("Manual capture only");
  expect(windowCaptureDescription(state)).toContain("Automatic capture isn't available");
  expect(windowCaptureFeedbackUnavailableMessage(state)).not.toContain("GNOME");
  expect(windowCaptureAccessibilityUnavailableMessage(state)).toContain(
    "only provides a screenshot",
  );
  expect(
    windowCaptureAccessibilityUnavailableMessage({ ...state, linuxBackend: "screenshot-portal" }),
  ).toContain("only provides a screenshot");
  expect(
    windowCaptureAccessibilityUnavailableMessage({ ...state, linuxBackend: "kde" }),
  ).toBeUndefined();
  expect(windowCaptureFeedbackUnavailableMessage({ ...state, linuxBackend: "kde" })).toContain(
    "capture helper",
  );
  expect(
    windowCaptureFeedbackUnavailableMessage({
      ...state,
      linuxBackend: "kde",
      linuxFeedbackAvailable: true,
      kdeHelper: { status: "ready", message: "Ready", feedbackAvailable: true },
    }),
  ).toBeUndefined();
  expect(
    windowCaptureStatus(
      { ...state, linuxBackend: "kde", kdeHelper: { status: "not-installed", message: "Install" } },
      true,
    ),
  ).toContain("Install the capture helper");
});

it("does not ask Niri users to repeat setup when its capture endpoint is available", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "niri",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutBinding: "Ctrl+Shift+2 { spawn ...; }",
    shortcutMessage: null,
    message: null,
  };
  expect(windowCaptureStatus(state, true)).toBe("Use your shortcut from another app");
  expect(windowCaptureSetupButtonLabel(state)).toBe("Manage capture");
});

it("reports pending, denied, and assigned shortcuts without inferring consent from saved keys", () => {
  const state: DesktopWindowCaptureState = {
    mode: "portal",
    linuxBackend: "screenshot-portal",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutPending: true,
    shortcutMessage: null,
    message: null,
  };
  expect(windowCaptureStatus(state, true)).toContain("Waiting for shortcut permission");
  expect(windowCaptureShortcutStatus(state)).toContain("Approve the shortcut permission prompt");
  const denied = { ...state, shortcutPending: false, shortcutMessage: "Permission wasn't granted" };
  expect(windowCaptureShortcutStatus(denied)).toBe("Permission wasn't granted");
  const approved = {
    ...denied,
    shortcutRegistered: true,
    shortcutLabel: "Press <Shift><Control>2",
    shortcutMessage: "Desktop shortcut: Press <Shift><Control>2",
  };
  expect(windowCaptureStatus(approved, true)).toBe("Ready to capture");
  expect(windowCaptureShortcutStatus(approved)).toBeNull();
  expect(windowCaptureShortcutStatus({ ...approved, shortcutPending: true })).toContain(
    "Approve the shortcut permission prompt",
  );
  expect(
    windowCaptureShortcutStatus({
      ...approved,
      shortcutRegistered: false,
      shortcutMessage: "Permission wasn't granted",
    }),
  ).toBe("Permission wasn't granted");
});
