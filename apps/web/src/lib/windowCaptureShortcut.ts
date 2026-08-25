import {
  isModifierPairShortcut,
  windowCaptureModifierPairLabel,
  windowCaptureShortcutModifierPair,
  type KeybindingShortcut,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";

import { formatShortcutLabel, shortcutConflictKey } from "../keybindings";
import { isMacPlatform } from "./utils";

export function formatWindowCaptureShortcutLabel(
  shortcut: WindowCaptureShortcut,
  platform = navigator.platform,
): string {
  return isModifierPairShortcut(shortcut)
    ? windowCaptureModifierPairLabel(
        windowCaptureShortcutModifierPair(shortcut),
        isMacPlatform(platform),
      )
    : formatShortcutLabel(shortcut, platform);
}

export function sameWindowCaptureShortcut(
  left: WindowCaptureShortcut,
  right: WindowCaptureShortcut,
  platform = navigator.platform,
): boolean {
  if (isModifierPairShortcut(left) || isModifierPairShortcut(right)) {
    return (
      isModifierPairShortcut(left) &&
      isModifierPairShortcut(right) &&
      windowCaptureShortcutModifierPair(left) === windowCaptureShortcutModifierPair(right)
    );
  }
  return shortcutConflictKey(left, platform) === shortcutConflictKey(right, platform);
}

export function windowCaptureKeybindingConflict<Command extends string>(
  shortcut: WindowCaptureShortcut,
  keybindings: ReadonlyArray<{ readonly command: Command; readonly shortcut: KeybindingShortcut }>,
  platform = navigator.platform,
): Command | null {
  if (isModifierPairShortcut(shortcut)) return null;
  const key = shortcutConflictKey(shortcut, platform);
  return (
    keybindings.find((binding) => shortcutConflictKey(binding.shortcut, platform) === key)
      ?.command ?? null
  );
}
