import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_WINDOW_CAPTURE_SHORTCUT,
  type ClientSettingsPatch,
  type DesktopWindowCaptureShortcutAvailability,
  type DesktopWindowCaptureState,
  type WindowCaptureModifier,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { PlayIcon } from "lucide-react";
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
  windowCaptureStatus,
  windowCaptureUnavailableMessage,
  windowCaptureSoundPatch,
  windowCaptureFeedbackUnavailableMessage,
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
import { Group } from "../ui/group";
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
  const unavailableMessage = windowCaptureUnavailableMessage(Boolean(bridge));
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const feedbackUnavailable = windowCaptureFeedbackUnavailableMessage(state);
  const savedShortcut = settings.windowCaptureShortcut;
  const shortcutChanged = !sameWindowCaptureShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const candidateConflict = shortcutChanged
    ? windowCaptureKeybindingConflict(candidate, keybindings)
    : null;
  const canSaveShortcut =
    shortcutChanged && candidateConflict === null && shortcutCheck.availability?.available === true;
  const soundSelection = settings.windowCapturePlaySound ? settings.windowCaptureSound : "off";

  const refreshState = useCallback(async () => {
    if (bridge) setState(await bridge.getWindowCaptureState());
  }, [bridge]);

  useEffect(() => {
    void refreshState();
    window.addEventListener("focus", refreshState);
    return () => window.removeEventListener("focus", refreshState);
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

  const saveEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled) await bridge?.requestWindowCapturePermissions();
      await save({ windowCaptureEnabled: enabled });
    },
    [bridge, save],
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
      const conflict = windowCaptureKeybindingConflict(shortcut, keybindings);
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
          : (state?.shortcutMessage ??
            (state?.shortcutRegistered ? "Available and reserved." : undefined));

  return (
    <SettingsPageContainer>
      <SettingsSection id="window-capture" title="Window Capture">
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...searchableSetting("window-capture-enabled")}
            description="Capture a window with available text and attach it to your current draft."
            status={bridge ? windowCaptureStatus(state, settings.windowCaptureEnabled) : undefined}
            control={
              <Switch
                checked={settings.windowCaptureEnabled}
                disabled={!captureAvailable}
                aria-label="Enable window capture"
                onCheckedChange={(checked) => void saveEnabled(checked)}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-shortcut")}
            description={
              state?.mode === "portal"
                ? "Choose a key chord. Modifier-pair shortcuts are not supported on Wayland."
                : "Use both Shift keys or another shortcut."
            }
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
            description="Choose the sound played when capture starts."
            control={
              <Group>
                <Select
                  disabled={!captureAvailable}
                  onValueChange={(value) =>
                    value &&
                    void save(windowCaptureSoundPatch(value as WindowCaptureSoundSelection))
                  }
                  value={soundSelection}
                >
                  <SelectTrigger
                    aria-label="Window capture sound"
                    className="w-auto min-w-24"
                    size="sm"
                  >
                    <SelectValue>
                      {soundSelection === "off"
                        ? "Off"
                        : soundSelection === "soft-pop"
                          ? "Whoosh (Default)"
                          : "Click"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="soft-pop">Whoosh (Default)</SelectItem>
                    <SelectItem value="camera-shutter">Click</SelectItem>
                  </SelectPopup>
                </Select>
                <Button
                  aria-label="Play window capture sound"
                  disabled={!captureAvailable || soundSelection === "off"}
                  onClick={() => playWindowCaptureSound(settings.windowCaptureSound)}
                  size="icon-sm"
                  variant="outline"
                >
                  <PlayIcon />
                </Button>
              </Group>
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-flash")}
            description="Show a gentle cue on the captured window."
            status={feedbackUnavailable}
            control={
              <Switch
                checked={!feedbackUnavailable && settings.windowCaptureFlash}
                disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                aria-label="Flash captured window"
                onCheckedChange={(checked) => void save({ windowCaptureFlash: checked })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("window-capture-animations")}
            description="Fly captured windows into the composer and animate capture feedback."
            status={feedbackUnavailable}
            control={
              <Switch
                checked={!feedbackUnavailable && settings.windowCaptureAnimations}
                disabled={!captureAvailable || Boolean(feedbackUnavailable)}
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
