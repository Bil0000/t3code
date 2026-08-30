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
  createRecordingRequestTracker,
  windowCaptureSoundPatch,
  type WindowCaptureSoundSelection,
} from "./WindowCaptureSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { WindowCaptureShortcutKeys } from "../desktop/WindowCaptureShortcutKeys";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

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
  const [recordingRequests] = useState(createRecordingRequestTracker);
  const shortcutCheckIdRef = useRef(0);
  const unavailableMessage = bridge
    ? undefined
    : window.desktopBridge
      ? "Update the desktop app to use window capture."
      : "Only available in the desktop app.";
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const savedShortcut = settings.windowCaptureShortcut;
  const shortcutChanged = !sameWindowCaptureShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const candidateConflict = shortcutChanged
    ? windowCaptureKeybindingConflict(
        effectiveWindowCaptureShortcut(state?.mode ?? "unavailable", candidate),
        keybindings,
      )
    : null;
  const canSaveShortcut =
    shortcutChanged && candidateConflict === null && shortcutCheck.availability?.available === true;
  const soundSelection = settings.windowCapturePlaySound ? settings.windowCaptureSound : "off";

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
    recordingRequests.clear();
    heldModifierCodesRef.current.clear();
    setRecording(false);
    void bridge?.setWindowCaptureShortcutSuppressed(false);
  }, [bridge, recordingRequests]);

  const startRecording = useCallback(async () => {
    if (!bridge) return;
    const recordingRequest = recordingRequests.tryBegin();
    if (!recordingRequest) return;
    heldModifierCodesRef.current.clear();
    setShortcutCheck({ status: "idle", availability: null });
    try {
      await bridge.setWindowCaptureShortcutSuppressed(true);
      if (recordingRequests.owns(recordingRequest)) setRecording(true);
    } catch (error) {
      if (!recordingRequests.owns(recordingRequest)) return;
      recordingRequests.clear();
      setShortcutCheck({
        status: "checked",
        availability: {
          available: false,
          message: error instanceof Error ? error.message : "Could not start shortcut recording.",
        },
      });
    }
  }, [bridge, recordingRequests]);

  useEffect(
    () => () => {
      recordingRequests.clear();
      void bridge?.setWindowCaptureShortcutSuppressed(false);
    },
    [bridge, recordingRequests],
  );

  const checkShortcut = useCallback(
    async (shortcut: WindowCaptureShortcut) => {
      const checkId = ++shortcutCheckIdRef.current;
      setCandidate(shortcut);
      const conflict = windowCaptureKeybindingConflict(
        effectiveWindowCaptureShortcut(state?.mode ?? "unavailable", shortcut),
        keybindings,
      );
      if (conflict || !bridge) return;
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
        if (held.has(leftCode) && held.has(rightCode)) {
          stopRecording();
          void checkShortcut(
            pairModifier === "shift"
              ? { kind: "both-shift-keys" }
              : { kind: "modifier-pair", modifier: pairModifier },
          );
        }
        return;
      }
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
    ? "Press both keys of a modifier, like left and right Shift, or press a key chord. Esc cancels."
    : candidateConflict
      ? `T3 Code already uses this for "${commandLabel(candidateConflict)}".`
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
            description="Press both keys of a modifier like Shift, or choose a key chord. T3 Code checks it before saving."
            status={shortcutStatus}
            resetAction={
              captureAvailable &&
              !sameWindowCaptureShortcut(savedShortcut, DEFAULT_WINDOW_CAPTURE_SHORTCUT) ? (
                <SettingResetButton
                  label="window capture shortcut"
                  onClick={() => void checkShortcut(DEFAULT_WINDOW_CAPTURE_SHORTCUT)}
                />
              ) : null
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
                  onClick={() => void startRecording()}
                  onKeyDown={recordShortcut}
                  onKeyUp={(event) => heldModifierCodesRef.current.delete(event.code)}
                  onBlur={stopRecording}
                >
                  {recording ? (
                    "Press shortcut..."
                  ) : (
                    <WindowCaptureShortcutKeys shortcut={displayShortcut} />
                  )}
                </Button>
                {shortcutChanged ? (
                  <Button
                    type="button"
                    size="xs"
                    disabled={!canSaveShortcut}
                    onClick={() => {
                      if (canSaveShortcut) void save({ windowCaptureShortcut: candidate });
                    }}
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-sound")}
            titleAction={
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!captureAvailable || soundSelection === "off"}
                onClick={() => playWindowCaptureSound(settings.windowCaptureSound)}
              >
                Test sound
              </Button>
            }
            description="Choose the sound played when capture starts."
            control={
              <Select
                disabled={!captureAvailable}
                onValueChange={(value) =>
                  value && void save(windowCaptureSoundPatch(value as WindowCaptureSoundSelection))
                }
                value={soundSelection}
              >
                <SelectTrigger
                  aria-label="Window capture sound"
                  className="w-fit min-w-0"
                  size="sm"
                >
                  <SelectValue>
                    {soundSelection === "off"
                      ? "Off"
                      : soundSelection === "soft-pop"
                        ? "Soft Pop (Default)"
                        : "Camera Shutter"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="soft-pop">Soft Pop (Default)</SelectItem>
                  <SelectItem value="camera-shutter">Camera Shutter</SelectItem>
                </SelectPopup>
              </Select>
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
            description="Fly captured windows into the composer and animate capture feedback."
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
