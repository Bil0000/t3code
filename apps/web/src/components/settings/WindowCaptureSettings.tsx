import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_WINDOW_CAPTURE_SHORTCUT,
  effectiveWindowCaptureShortcut,
  type ClientSettingsPatch,
  type DesktopWindowCaptureShortcutAvailability,
  type DesktopWindowCaptureState,
  type WindowCaptureModifier,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { getDesktopWindowCaptureBridge } from "../../lib/desktopWindowCapture";
import {
  formatWindowCaptureShortcutLabel,
  sameWindowCaptureShortcut,
  windowCaptureKeybindingConflict,
} from "../../lib/windowCaptureShortcut";
import { playWindowCaptureSound } from "../../lib/windowCaptureSound";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel, keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Switch } from "../ui/switch";

const MODIFIER_PAIR_DOUBLE_TAP_MS = 400;
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

function modifierPairShortcut(modifier: WindowCaptureModifier): WindowCaptureShortcut {
  return modifier === "shift" ? { kind: "both-shift-keys" } : { kind: "modifier-pair", modifier };
}

type ShortcutCheck =
  | { readonly status: "idle"; readonly availability: null }
  | { readonly status: "checking"; readonly availability: null }
  | {
      readonly status: "checked";
      readonly availability: DesktopWindowCaptureShortcutAvailability;
    };

function captureStatus(state: DesktopWindowCaptureState | null, enabled: boolean): string {
  if (!state) return "Checking desktop support...";
  if (state.mode === "unavailable") return state.message ?? "Not supported on this platform.";
  if (!enabled) return "Turn this on to register the shortcut.";
  if (state.message) return state.message;
  if (!state.shortcutRegistered) return "The shortcut could not be registered.";
  return state.mode === "portal"
    ? "Ready. Your system will ask you to choose a window."
    : "Ready. The active window will be captured.";
}

export function isWindowCaptureAvailable(
  hasBridge: boolean,
  state: Pick<DesktopWindowCaptureState, "mode"> | null,
): boolean {
  return hasBridge && state !== null && state.mode !== "unavailable";
}

export function WindowCaptureSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = getDesktopWindowCaptureBridge();
  const [state, setState] = useState<DesktopWindowCaptureState | null>(null);
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<WindowCaptureShortcut>(settings.windowCaptureShortcut);
  const [shortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  const heldModifierCodesRef = useRef(new Set<string>());
  const lastModifierTapRef = useRef<{ code: string; time: number } | null>(null);
  const shortcutCheckIdRef = useRef(0);
  const unavailableMessage = bridge
    ? undefined
    : window.desktopBridge
      ? "Update the desktop app to use window capture."
      : "Only available in the desktop app.";
  const captureAvailable = isWindowCaptureAvailable(Boolean(bridge), state);
  const savedShortcut = settings.windowCaptureShortcut;
  const shortcutChanged = !sameWindowCaptureShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const canSaveShortcut = shortcutChanged && shortcutCheck.availability?.available === true;

  const refreshState = useCallback(async () => {
    if (bridge) setState(await bridge.getWindowCaptureState());
  }, [bridge]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }, [savedShortcut]);

  const save = useCallback(
    async (patch: ClientSettingsPatch) => {
      await updateSettings(patch);
      await refreshState();
    },
    [refreshState, updateSettings],
  );

  const stopRecording = useCallback(() => {
    heldModifierCodesRef.current.clear();
    lastModifierTapRef.current = null;
    setRecording(false);
  }, []);

  const checkShortcut = useCallback(
    async (shortcut: WindowCaptureShortcut) => {
      const checkId = ++shortcutCheckIdRef.current;
      setCandidate(shortcut);
      const conflict = windowCaptureKeybindingConflict(
        effectiveWindowCaptureShortcut(state?.mode ?? "unavailable", shortcut),
        keybindings,
      );
      if (conflict) {
        setShortcutCheck({
          status: "checked",
          availability: {
            available: false,
            message: `T3 Code already uses this for "${commandLabel(conflict)}".`,
          },
        });
        return;
      }
      if (!bridge) return;
      setShortcutCheck({ status: "checking", availability: null });
      try {
        const availability = await bridge.checkWindowCaptureShortcut(shortcut);
        if (checkId === shortcutCheckIdRef.current) {
          setShortcutCheck({ status: "checked", availability });
        }
      } catch (error) {
        if (checkId !== shortcutCheckIdRef.current) return;
        setShortcutCheck({
          status: "checked",
          availability: {
            available: false,
            message: error instanceof Error ? error.message : "Could not check this shortcut.",
          },
        });
      }
    },
    [bridge, keybindings, state?.mode],
  );

  const recordShortcut = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!recording || event.key === "Tab" || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        stopRecording();
        return;
      }
      const pairModifier = MODIFIER_FROM_KEY[event.key];
      if (pairModifier) {
        const held = heldModifierCodesRef.current;
        held.add(event.code);
        const [leftCode, rightCode] = MODIFIER_CODES[pairModifier];
        const bothHeld = held.has(leftCode) && held.has(rightCode);
        const lastTap = lastModifierTapRef.current;
        const doubleTap =
          lastTap?.code === event.code &&
          event.timeStamp - lastTap.time <= MODIFIER_PAIR_DOUBLE_TAP_MS;
        if (bothHeld || doubleTap) {
          stopRecording();
          void checkShortcut(modifierPairShortcut(pairModifier));
          return;
        }
        lastModifierTapRef.current = { code: event.code, time: event.timeStamp };
        return;
      }
      lastModifierTapRef.current = null;
      const input = keybindingFromKeyboardEvent(event, navigator.platform);
      if (!input) return;
      const shortcut = parseKeybindingShortcut(input);
      if (!shortcut) return;
      stopRecording();
      void checkShortcut(shortcut);
    },
    [checkShortcut, recording, stopRecording],
  );

  const shortcutStatus = recording
    ? "Double-tap a modifier, press both of its keys, or press a key chord. Esc cancels."
    : shortcutCheck.status === "checking"
      ? "Checking T3 Code, the system, and other apps..."
      : shortcutCheck.availability
        ? shortcutCheck.availability.available
          ? (shortcutCheck.availability.message ?? "Available. Save to apply.")
          : shortcutCheck.availability.message
        : (state?.message ?? (state?.shortcutRegistered ? "Available and reserved." : undefined));

  return (
    <SettingsPageContainer>
      <SettingsSection id="window-capture" title="Window Capture">
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...searchableSetting("window-capture-enabled")}
            description="Capture a window with available text and attach it to your current draft."
            status={bridge ? captureStatus(state, settings.windowCaptureEnabled) : undefined}
            control={
              <Switch
                checked={settings.windowCaptureEnabled}
                disabled={!captureAvailable}
                aria-label="Enable window capture"
                onCheckedChange={(checked) => void save({ windowCaptureEnabled: checked })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-shortcut")}
            description="Double-tap a modifier like Shift, press both of its keys, or choose a key chord. T3 Code checks it before saving."
            status={shortcutStatus}
            resetAction={
              <SettingResetButton
                label="window capture shortcut"
                disabled={
                  !captureAvailable ||
                  sameWindowCaptureShortcut(savedShortcut, DEFAULT_WINDOW_CAPTURE_SHORTCUT)
                }
                onClick={() =>
                  void save({ windowCaptureShortcut: DEFAULT_WINDOW_CAPTURE_SHORTCUT })
                }
              />
            }
            control={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant={recording ? "secondary" : "outline"}
                  disabled={!captureAvailable}
                  aria-label={`Record window capture shortcut, currently ${formatWindowCaptureShortcutLabel(displayShortcut)}`}
                  aria-pressed={recording}
                  data-keybinding-capture=""
                  onClick={() => {
                    heldModifierCodesRef.current.clear();
                    lastModifierTapRef.current = null;
                    setShortcutCheck({ status: "idle", availability: null });
                    setRecording(true);
                  }}
                  onKeyDown={recordShortcut}
                  onKeyUp={(event) => heldModifierCodesRef.current.delete(event.code)}
                  onBlur={stopRecording}
                >
                  {recording ? (
                    "Press shortcut..."
                  ) : (
                    <Kbd>{formatWindowCaptureShortcutLabel(displayShortcut)}</Kbd>
                  )}
                </Button>
                {shortcutChanged ? (
                  <Button
                    type="button"
                    size="xs"
                    disabled={!canSaveShortcut}
                    onClick={() => void save({ windowCaptureShortcut: candidate })}
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-sound")}
            title={
              <span className="inline-flex items-center gap-2">
                Capture sound
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!captureAvailable}
                  onClick={playWindowCaptureSound}
                >
                  Test sound
                </Button>
              </span>
            }
            description="Play a short sound after the image is attached."
            control={
              <Switch
                checked={settings.windowCapturePlaySound}
                disabled={!captureAvailable}
                aria-label="Play window capture sound"
                onCheckedChange={(checked) => void save({ windowCapturePlaySound: checked })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-flash")}
            description="Show a gentle cue on the captured window."
            control={
              <Switch
                checked={settings.windowCaptureFlash}
                disabled={!captureAvailable}
                aria-label="Flash captured window"
                onCheckedChange={(checked) => void save({ windowCaptureFlash: checked })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-animations")}
            description="Animate new capture cards and capture feedback."
            control={
              <Switch
                checked={settings.windowCaptureAnimations}
                disabled={!captureAvailable}
                aria-label="Animate window captures"
                onCheckedChange={(checked) => void save({ windowCaptureAnimations: checked })}
              />
            }
          />
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
