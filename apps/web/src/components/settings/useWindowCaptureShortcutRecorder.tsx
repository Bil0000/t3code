import {
  isModifierPairShortcut,
  type WindowCaptureModifier,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getDesktopWindowCaptureBridge } from "../../lib/desktopWindowCapture";
import {
  formatWindowCaptureShortcutLabel,
  parseDesktopWindowCaptureShortcut,
} from "../../lib/windowCaptureShortcut";
import { WindowCaptureShortcutKeys } from "../desktop/WindowCaptureShortcutKeys";
import { Button } from "../ui/button";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { createRecordingRequestTracker } from "./WindowCaptureSettings.logic";

const MODIFIER_FROM_KEY: Readonly<Record<string, WindowCaptureModifier>> = {
  Shift: "shift",
  Meta: "meta",
  OS: "meta",
  Control: "control",
  Alt: "alt",
  AltGraph: "alt",
};
const MODIFIER_CODES: Readonly<Record<WindowCaptureModifier, readonly [string, string]>> = {
  shift: ["ShiftLeft", "ShiftRight"],
  meta: ["MetaLeft", "MetaRight"],
  control: ["ControlLeft", "ControlRight"],
  alt: ["AltLeft", "AltRight"],
};

/** The same recorder for inline changes and config-backed setup, without saving either. */
export function useWindowCaptureShortcutRecorder({
  shortcut,
  shortcutLabel,
  disabled = false,
  allowModifierPairs = true,
  onRecord,
  onStart,
  onError,
}: {
  shortcut: WindowCaptureShortcut;
  shortcutLabel?: string | undefined;
  disabled?: boolean;
  allowModifierPairs?: boolean;
  onRecord: (shortcut: WindowCaptureShortcut) => void;
  onStart?: () => void;
  onError: (message: string) => void;
}) {
  const bridge = getDesktopWindowCaptureBridge();
  const displayShortcut = shortcutLabel
    ? parseDesktopWindowCaptureShortcut(shortcutLabel)
    : shortcut;
  const [recording, setRecording] = useState(false);
  const [requests] = useState(createRecordingRequestTracker);
  const heldModifierCodes = useRef(new Set<string>());
  const stopRecording = useCallback(() => {
    requests.clear();
    heldModifierCodes.current.clear();
    setRecording(false);
    void bridge?.setWindowCaptureShortcutSuppressed(false).catch(() => undefined);
  }, [bridge, requests]);
  const startRecording = async () => {
    if (!bridge || disabled) return;
    const request = requests.tryBegin();
    if (!request) return;
    heldModifierCodes.current.clear();
    onStart?.();
    try {
      await bridge.setWindowCaptureShortcutSuppressed(true);
      if (requests.owns(request)) setRecording(true);
    } catch (error) {
      if (!requests.owns(request)) return;
      requests.clear();
      onError(error instanceof Error ? error.message : "Could not start shortcut recording.");
    }
  };
  useEffect(
    () => () => {
      requests.clear();
      void bridge?.setWindowCaptureShortcutSuppressed(false).catch(() => undefined);
    },
    [bridge, requests],
  );
  const recordShortcut = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.key === "Tab" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const modifier = MODIFIER_FROM_KEY[event.key];
    if (modifier) {
      const held = heldModifierCodes.current;
      held.add(event.code);
      const [left, right] = MODIFIER_CODES[modifier];
      if (held.has(left) && held.has(right)) {
        if (!allowModifierPairs) {
          onError("Add a letter, number, or function key to your shortcut.");
          return;
        }
        stopRecording();
        onRecord(
          modifier === "shift" ? { kind: "both-shift-keys" } : { kind: "modifier-pair", modifier },
        );
      }
      return;
    }
    const input = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!input) return;
    const next = parseKeybindingShortcut(input);
    if (!next) return;
    stopRecording();
    onRecord(next);
  };

  return {
    recording,
    stopRecording,
    input: (
      <Button
        type="button"
        variant={recording ? "secondary" : "outline"}
        disabled={disabled}
        aria-label={
          displayShortcut
            ? `Record window capture shortcut, currently ${formatWindowCaptureShortcutLabel(displayShortcut)}`
            : "Change window capture shortcut"
        }
        aria-pressed={recording}
        data-keybinding-capture=""
        onClick={() => void startRecording()}
        onKeyDown={recordShortcut}
        onKeyUp={(event) => heldModifierCodes.current.delete(event.code)}
        onBlur={stopRecording}
      >
        {recording ? (
          "Press shortcut…"
        ) : !displayShortcut ? (
          "Change shortcut"
        ) : !allowModifierPairs && isModifierPairShortcut(displayShortcut) ? (
          "Choose shortcut"
        ) : (
          <WindowCaptureShortcutKeys shortcut={displayShortcut} />
        )}
      </Button>
    ),
  };
}
