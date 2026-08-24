// @effect-diagnostics globalTimers:off

import {
  WAYLAND_WINDOW_CAPTURE_SHORTCUT,
  type WindowCaptureKeyChord,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";

interface AccessibilityTreeNode {
  readonly name?: string;
  readonly value?: string;
  readonly children: ReadonlyArray<AccessibilityTreeNode>;
}

const MAX_ACCESSIBILITY_TREE_NODES = 10_000;
const WINDOW_BLUR_TIMEOUT_MS = 1_000;
const LEFT_SHIFT_KEYCODE = 42;
const RIGHT_SHIFT_KEYCODE = 54;

export interface BothShiftKeysState {
  readonly leftPressed: boolean;
  readonly rightPressed: boolean;
  readonly active: boolean;
}

export const BOTH_SHIFT_KEYS_IDLE: BothShiftKeysState = {
  leftPressed: false,
  rightPressed: false,
  active: false,
};

export function updateBothShiftKeys(
  state: BothShiftKeysState,
  keycode: number,
  pressed: boolean,
): { readonly state: BothShiftKeysState; readonly triggered: boolean } {
  if (keycode !== LEFT_SHIFT_KEYCODE && keycode !== RIGHT_SHIFT_KEYCODE) {
    return { state, triggered: false };
  }
  const leftPressed = keycode === LEFT_SHIFT_KEYCODE ? pressed : state.leftPressed;
  const rightPressed = keycode === RIGHT_SHIFT_KEYCODE ? pressed : state.rightPressed;
  const active = leftPressed && rightPressed;
  return {
    state: { leftPressed, rightPressed, active },
    triggered: active && !state.active,
  };
}

export function isBothShiftKeysShortcut(
  shortcut: WindowCaptureShortcut,
): shortcut is Extract<WindowCaptureShortcut, { readonly kind: "both-shift-keys" }> {
  return "kind" in shortcut && shortcut.kind === "both-shift-keys";
}

export function effectiveWindowCaptureShortcut(
  mode: "direct" | "portal" | "unavailable",
  shortcut: WindowCaptureShortcut,
): WindowCaptureShortcut {
  return mode === "portal" && isBothShiftKeysShortcut(shortcut)
    ? WAYLAND_WINDOW_CAPTURE_SHORTCUT
    : shortcut;
}

const COMMON_MOD_ACTIONS: Readonly<Record<string, string>> = {
  a: "Select All",
  c: "Copy",
  f: "Find",
  n: "New",
  o: "Open",
  p: "Print",
  q: "Quit",
  s: "Save",
  t: "New Tab",
  v: "Paste",
  w: "Close Window",
  x: "Cut",
  z: "Undo",
};

export function windowCaptureShortcutSystemConflict(
  shortcut: WindowCaptureKeyChord,
): string | null {
  const modifierCount = [
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
  ].filter(Boolean).length;
  if (modifierCount !== 1) return null;
  if (shortcut.shiftKey) {
    return "Shift combinations are used for typing and text selection. Add another modifier.";
  }
  const key = shortcut.key.toLowerCase();
  if (shortcut.modKey) {
    const action = COMMON_MOD_ACTIONS[key];
    return action ? `This shortcut is ${action} in most apps.` : null;
  }
  if (shortcut.ctrlKey && ["c", "d", "z"].includes(key)) {
    return "This shortcut controls running commands in terminals.";
  }
  if (shortcut.altKey && key === "tab") return "The system uses Alt+Tab to switch apps.";
  if (shortcut.metaKey && ["l", " "].includes(key)) {
    return "The system already uses this shortcut.";
  }
  return null;
}

export function accessibleWindowText(root: AccessibilityTreeNode, maxChars: number): string {
  const seen = new Set<string>();
  const stack = [root];
  let text = "";
  let visited = 0;
  while (stack.length > 0 && text.length < maxChars && visited < MAX_ACCESSIBILITY_TREE_NODES) {
    const node = stack.pop()!;
    visited += 1;
    for (const value of [node.name, node.value]) {
      const candidate = value?.replaceAll("\0", "").trim();
      if (!candidate || seen.has(candidate)) continue;

      const separator = text ? "\n" : "";
      const remaining = maxChars - text.length - separator.length;
      if (remaining <= 0) return text;
      const candidateEnd =
        candidate.length <= remaining
          ? candidate.length
          : /[\uD800-\uDBFF]/.test(candidate[remaining - 1] ?? "")
            ? remaining - 1
            : remaining;
      if (candidateEnd === 0) return text;
      text += separator + candidate.slice(0, candidateEnd);
      if (candidateEnd < candidate.length) return text;
      seen.add(candidate);
    }
    stack.push(...node.children.toReversed());
  }
  return text;
}

export function hideAndWaitForBlur(window: {
  readonly hide: () => void;
  readonly once: (event: "blur", listener: () => void) => unknown;
  readonly removeListener: (event: "blur", listener: () => void) => unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeListener("blur", onBlur);
      reject(new Error("Timed out waiting for T3 Code to lose focus."));
    }, WINDOW_BLUR_TIMEOUT_MS);
    const onBlur = () => {
      clearTimeout(timeout);
      resolve();
    };
    window.once("blur", onBlur);
    window.hide();
  });
}

type WindowBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function findAccessibleWindow<
  T extends { readonly name: string | null; readonly bounds: WindowBounds | null },
>(
  windows: readonly T[],
  captured: {
    readonly title: string;
    readonly sourceTitle?: string;
    readonly bounds: WindowBounds;
  },
): T | undefined {
  const title = captured.title.trim() || captured.sourceTitle?.trim() || "";
  if (!title) return undefined;
  const matches = windows.filter((window) => {
    const bounds = window.bounds;
    return (
      window.name?.trim() === title &&
      bounds !== null &&
      (["x", "y", "width", "height"] as const).every(
        (key) => Math.abs(bounds[key] - captured.bounds[key]) <= 2,
      )
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  "+": "Plus",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Escape: "Esc",
};

export function toElectronAccelerator(shortcut: WindowCaptureKeyChord): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CommandOrControl");
  if (shortcut.metaKey) parts.push("Super");
  if (shortcut.ctrlKey) parts.push("Control");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase());
  return parts.join("+");
}

interface CaptureSourceLike {
  readonly id: string;
  readonly name: string;
}

interface ActiveWindowLike {
  readonly id: number;
  readonly title: string;
}

export function findCaptureSource<T extends CaptureSourceLike>(
  sources: readonly T[],
  activeWindow: ActiveWindowLike,
): T | undefined {
  const idPrefix = `window:${activeWindow.id}:`;
  const idMatch = sources.find((source) => source.id.startsWith(idPrefix));
  if (idMatch) return idMatch;

  const title = activeWindow.title.trim();
  if (!title) return undefined;
  const titleMatches = sources.filter((source) => source.name.trim() === title);
  return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

export function shouldRequestScreenCapturePermission(
  platform: NodeJS.Platform,
  previouslyEnabled: boolean,
  enabled: boolean,
): boolean {
  return platform === "darwin" && !previouslyEnabled && enabled;
}

export function isWaylandSession(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    platform === "linux" &&
    (environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
      Boolean(environment.WAYLAND_DISPLAY))
  );
}
