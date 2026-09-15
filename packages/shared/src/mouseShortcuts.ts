export const MOUSE_SHORTCUTS_CHANNEL = "t3:mouse-shortcuts";
export const MOUSE_SHORTCUT_INPUT_CHANNEL = "t3:mouse-shortcut-input";
export const MOUSE_SHORTCUT_CANCEL_CHANNEL = "t3:mouse-shortcut-cancel";

export function mouseShortcutInputKey(input: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string {
  return [input.button, input.metaKey, input.ctrlKey, input.altKey, input.shiftKey].join("|");
}
