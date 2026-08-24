import {
  DEFAULT_WINDOW_CAPTURE_SHORTCUT,
  type ClientSettingsPatch,
  type DesktopWindowCaptureState,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { CameraIcon } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { formatShortcutLabel } from "../../keybindings";
import {
  keybindingFromKeyboardEvent,
  shortcutToKeybindingInput,
} from "./KeybindingsSettings.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

function captureStatus(
  state: DesktopWindowCaptureState | null,
  enabled: boolean,
  hasDesktopBridge: boolean,
): string {
  if (!hasDesktopBridge) return "Available in the desktop app.";
  if (!state) return "Checking desktop support…";
  if (state.mode === "unavailable") return state.message ?? "Not supported on this platform.";
  if (!enabled) return "Turn this on to register the shortcut.";
  if (!state.shortcutRegistered) return state.message ?? "The shortcut could not be registered.";
  return state.mode === "portal"
    ? "Ready. Your system will ask you to choose a window."
    : "Ready. The active window will be captured.";
}

export function WindowCaptureSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const bridge = window.desktopBridge;
  const [state, setState] = useState<DesktopWindowCaptureState | null>(null);
  const [recording, setRecording] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const refreshState = useCallback(async () => {
    if (bridge) setState(await bridge.getWindowCaptureState());
  }, [bridge]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const save = useCallback(
    async (patch: ClientSettingsPatch) => {
      await updateSettings(patch);
      await refreshState();
    },
    [refreshState, updateSettings],
  );

  const recordShortcut = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const input = keybindingFromKeyboardEvent(event, navigator.platform);
      if (!input) return;
      const shortcut = parseKeybindingShortcut(input);
      if (!shortcut) return;
      setRecording(false);
      void save({ windowCaptureShortcut: shortcut });
    },
    [recording, save],
  );

  const captureNow = useCallback(async () => {
    if (!bridge || capturing) return;
    setCapturing(true);
    try {
      await bridge.captureWindow();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Window capture failed",
          description: error instanceof Error ? error.message : "Try the capture again.",
        }),
      );
    } finally {
      setCapturing(false);
      await refreshState();
    }
  }, [bridge, capturing, refreshState]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="window-capture"
        title="Window Capture"
        icon={<CameraIcon className="size-4.5" />}
      >
        <SettingsRow
          {...searchableSetting("window-capture-enabled")}
          description="Capture a window from anywhere and attach it to your current draft."
          status={captureStatus(state, settings.windowCaptureEnabled, Boolean(bridge))}
          control={
            <Switch
              checked={settings.windowCaptureEnabled}
              disabled={!bridge}
              aria-label="Enable window capture"
              onCheckedChange={(checked) => void save({ windowCaptureEnabled: checked })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("window-capture-shortcut")}
          description="Click the shortcut, then press a key with at least one modifier."
          resetAction={
            <SettingResetButton
              label="window capture shortcut"
              disabled={
                shortcutToKeybindingInput(settings.windowCaptureShortcut) ===
                shortcutToKeybindingInput(DEFAULT_WINDOW_CAPTURE_SHORTCUT)
              }
              onClick={() => void save({ windowCaptureShortcut: DEFAULT_WINDOW_CAPTURE_SHORTCUT })}
            />
          }
          control={
            <Button
              type="button"
              size="sm"
              variant={recording ? "secondary" : "outline"}
              disabled={!bridge}
              aria-label="Record window capture shortcut"
              onClick={() => setRecording(true)}
              onKeyDown={recordShortcut}
              onBlur={() => setRecording(false)}
            >
              {recording ? (
                "Press shortcut…"
              ) : (
                <Kbd>{formatShortcutLabel(settings.windowCaptureShortcut)}</Kbd>
              )}
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting("window-capture-sound")}
          description="Play a short sound after the image is attached."
          control={
            <Switch
              checked={settings.windowCapturePlaySound}
              aria-label="Play window capture sound"
              onCheckedChange={(checked) => void save({ windowCapturePlaySound: checked })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("window-capture-flash")}
          description="Flash the captured window after the image is saved."
          control={
            <Switch
              checked={settings.windowCaptureFlash}
              disabled={!bridge}
              aria-label="Flash captured window"
              onCheckedChange={(checked) => void save({ windowCaptureFlash: checked })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("window-capture-animations")}
          description="Animate new capture cards and the capture flash."
          control={
            <Switch
              checked={settings.windowCaptureAnimations}
              aria-label="Animate window captures"
              onCheckedChange={(checked) => void save({ windowCaptureAnimations: checked })}
            />
          }
        />
        <SettingsRow
          title="Capture now"
          description="Capture once without changing the global shortcut setting."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!bridge || capturing}
              onClick={() => void captureNow()}
            >
              <CameraIcon className="size-3.5" />
              {capturing ? "Capturing…" : "Capture window"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
