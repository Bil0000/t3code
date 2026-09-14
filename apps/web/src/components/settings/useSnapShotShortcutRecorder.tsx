import {
  isModifierPairShortcut,
  type SnapShotModifier,
  type SnapShotModifierKey,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  formatSnapShotShortcutLabel,
  parseDesktopSnapShotShortcut,
} from "../../lib/snapShotShortcut";
import { SnapShotShortcutKeys } from "../desktop/SnapShotShortcutKeys";
import { Button } from "../ui/button";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { createRecordingRequestTracker } from "./SnapShotSettings.logic";

const MODIFIER_FROM_KEY: Readonly<Record<string, SnapShotModifier>> = {
  Shift: "shift",
  Meta: "meta",
  OS: "meta",
  Control: "control",
  Alt: "alt",
  AltGraph: "alt",
};
const MODIFIER_CODES: Readonly<Record<SnapShotModifier, readonly [string, string]>> = {
  shift: ["ShiftLeft", "ShiftRight"],
  meta: ["MetaLeft", "MetaRight"],
  control: ["ControlLeft", "ControlRight"],
  alt: ["AltLeft", "AltRight"],
};

/** The same recorder for inline changes and config-backed setup, without saving either. */
export function useSnapShotShortcutRecorder({
  shortcut,
  shortcutLabel,
  disabled = false,
  allowModifierPairs = true,
  onRecord,
  onStart,
  onError,
}: {
  shortcut: SnapShotShortcut | undefined;
  shortcutLabel?: string | undefined;
  disabled?: boolean;
  allowModifierPairs?: boolean;
  onRecord: (shortcut: SnapShotShortcut) => void;
  onStart?: () => void;
  onError: (message: string) => void;
}) {
  const bridge = getDesktopSnapShotBridge();
  const displayShortcut = shortcutLabel ? parseDesktopSnapShotShortcut(shortcutLabel) : shortcut;
  const [recording, setRecording] = useState(false);
  const [requests] = useState(createRecordingRequestTracker);
  const heldModifierCodes = useRef(new Set<string>());
  const tooManyModifiers = useRef(false);
  const stopRecording = useCallback(() => {
    requests.clear();
    heldModifierCodes.current.clear();
    tooManyModifiers.current = false;
    setRecording(false);
    void bridge?.setSnapShotShortcutSuppressed(false).catch(() => undefined);
  }, [bridge, requests]);
  const startRecording = async () => {
    if (!bridge || disabled) return;
    const request = requests.tryBegin();
    if (!request) return;
    heldModifierCodes.current.clear();
    onStart?.();
    try {
      await bridge.setSnapShotShortcutSuppressed(true);
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
      void bridge?.setSnapShotShortcutSuppressed(false).catch(() => undefined);
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
      if (held.size > 2) tooManyModifiers.current = true;
      if (held.size === 2 && !allowModifierPairs) {
        onError(
          "This desktop cannot preserve left/right modifier pairs. Add a letter, number, or function key.",
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
        size="xs"
        variant={recording ? "secondary" : "outline"}
        disabled={disabled}
        aria-label={
          displayShortcut
            ? `Record snapshot shortcut, currently ${formatSnapShotShortcutLabel(displayShortcut)}`
            : shortcut === undefined
              ? "Record snapshot shortcut"
              : "Change snapshot shortcut"
        }
        aria-pressed={recording}
        data-keybinding-capture=""
        onClick={() => void startRecording()}
        onKeyDown={recordShortcut}
        onKeyUp={(event) => {
          const held = heldModifierCodes.current;
          if (
            recording &&
            allowModifierPairs &&
            !tooManyModifiers.current &&
            held.has(event.code) &&
            held.size === 2
          ) {
            const keys = [...held].sort() as [SnapShotModifierKey, SnapShotModifierKey];
            const modifier = MODIFIER_FROM_KEY[event.key];
            const pair = modifier && MODIFIER_CODES[modifier];
            const sameModifier = pair && held.has(pair[0]) && held.has(pair[1]);
            stopRecording();
            onRecord(
              sameModifier
                ? modifier === "shift"
                  ? { kind: "both-shift-keys" }
                  : { kind: "modifier-pair", modifier }
                : { kind: "modifier-keys", keys },
            );
          } else {
            held.delete(event.code);
            if (held.size === 0) tooManyModifiers.current = false;
          }
        }}
        onBlur={stopRecording}
      >
        {recording ? (
          "Press shortcut…"
        ) : !displayShortcut ? (
          shortcut === undefined ? (
            "Record shortcut"
          ) : (
            "Change shortcut"
          )
        ) : !allowModifierPairs && isModifierPairShortcut(displayShortcut) ? (
          "Choose shortcut"
        ) : (
          <SnapShotShortcutKeys shortcut={displayShortcut} />
        )}
      </Button>
    ),
  };
}
