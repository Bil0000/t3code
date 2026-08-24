import type { KeybindingShortcut, WindowCaptureShortcut } from "@t3tools/contracts";

import { formatShortcutLabel, shortcutConflictKey } from "../keybindings";

function isBothShiftKeys(
  shortcut: WindowCaptureShortcut,
): shortcut is Extract<WindowCaptureShortcut, { readonly kind: "both-shift-keys" }> {
  return "kind" in shortcut;
}

export function formatWindowCaptureShortcutLabel(
  shortcut: WindowCaptureShortcut,
  platform = navigator.platform,
): string {
  return isBothShiftKeys(shortcut) ? "Shift + Shift" : formatShortcutLabel(shortcut, platform);
}

export function sameWindowCaptureShortcut(
  left: WindowCaptureShortcut,
  right: WindowCaptureShortcut,
  platform = navigator.platform,
): boolean {
  const leftIsShiftPair = isBothShiftKeys(left);
  const rightIsShiftPair = isBothShiftKeys(right);
  if (leftIsShiftPair || rightIsShiftPair) return leftIsShiftPair && rightIsShiftPair;
  return shortcutConflictKey(left, platform) === shortcutConflictKey(right, platform);
}

export function windowCaptureKeybindingConflict<Command extends string>(
  shortcut: WindowCaptureShortcut,
  keybindings: ReadonlyArray<{ readonly command: Command; readonly shortcut: KeybindingShortcut }>,
  platform = navigator.platform,
): Command | null {
  if (isBothShiftKeys(shortcut)) return null;
  const key = shortcutConflictKey(shortcut, platform);
  return (
    keybindings.find((binding) => shortcutConflictKey(binding.shortcut, platform) === key)
      ?.command ?? null
  );
}
