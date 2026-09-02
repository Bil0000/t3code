import { useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettingsPatch,
  type DesktopWindowCaptureShortcutAvailability,
  type DesktopWindowCaptureState,
  type DesktopWindowCaptureSetupAction,
  type WindowCaptureModifier,
  type WindowCaptureShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

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
  windowCaptureShortcutStatus,
  windowCaptureSetupButtonLabel,
  windowCaptureUnavailableMessage,
  windowCaptureSoundPatch,
  windowCaptureFeedbackUnavailableMessage,
  windowCaptureDescription,
  windowCaptureAccessibilityUnavailableMessage,
  type WindowCaptureSoundSelection,
} from "./WindowCaptureSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { WindowCaptureShortcutKeys } from "../desktop/WindowCaptureShortcutKeys";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { selectTriggerVariants } from "../ui/select";
import { Switch } from "../ui/switch";
import { WindowCaptureSetupDialog } from "./WindowCaptureSetupDialog";
import { NiriCaptureShortcutInstructions } from "./NiriCaptureShortcutInstructions";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupShouldDisableOnClose,
  type CaptureSetupStep,
} from "./WindowCaptureSetupDialog.logic";

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

const soundOptionRowClassName =
  "grid grid-cols-[1fr_auto] rounded-sm has-data-checked:bg-foreground/[0.08]";
const soundOptionItemClassName = "data-checked:bg-transparent";
const soundPreviewClassName = "min-h-7 w-7 justify-center px-0";

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
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{
    initialStep: CaptureSetupStep;
    wasEnabled: boolean;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [showNiriShortcut, setShowNiriShortcut] = useState(false);
  const [candidate, setCandidate] = useState<WindowCaptureShortcut>(settings.windowCaptureShortcut);
  const [shortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  const heldModifierCodesRef = useRef(new Set<string>());
  const [recordingRequests] = useState(createRecordingRequestTracker);
  const shortcutCheckIdRef = useRef(0);
  const stateRequestIdRef = useRef(0);
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
  const soundLabel =
    soundSelection === "off" ? "Off" : soundSelection === "soft-pop" ? "Whoosh (Default)" : "Click";

  const refreshState = useCallback(async () => {
    const requestId = ++stateRequestIdRef.current;
    try {
      if (bridge) {
        const nextState = await bridge.getWindowCaptureState();
        if (requestId === stateRequestIdRef.current) setState(nextState);
        return nextState;
      }
    } catch (error) {
      if (requestId === stateRequestIdRef.current)
        setSetupError(error instanceof Error ? error.message : "Could not check capture setup.");
    }
  }, [bridge]);

  const setup = useCallback(
    async (action: DesktopWindowCaptureSetupAction) => {
      if (!bridge?.setupWindowCapture || setupBusy) return;
      setSetupBusy(true);
      setSetupError(null);
      try {
        await bridge.setupWindowCapture(action);
        await refreshState();
      } catch (error) {
        setSetupError(error instanceof Error ? error.message : "Could not complete capture setup.");
      } finally {
        setSetupBusy(false);
      }
    },
    [bridge, refreshState, setupBusy],
  );

  useEffect(() => {
    void refreshState();
    window.addEventListener("focus", refreshState);
    return () => window.removeEventListener("focus", refreshState);
  }, [refreshState]);

  useEffect(
    () =>
      bridge?.onMenuAction((action) => {
        if (action === "window-capture-shortcut-changed") void refreshState();
      }),
    [bridge, refreshState],
  );

  useEffect(() => {
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }, [savedShortcut]);

  const save = useCallback(
    async (patch: ClientSettingsPatch) => {
      setSetupError(null);
      try {
        await updateSettings(patch);
        return await refreshState();
      } catch (error) {
        setSetupError(error instanceof Error ? error.message : "Could not save capture settings.");
      }
    },
    [refreshState, updateSettings],
  );

  const saveIncludeAccessibility = useCallback(
    async (includeAccessibility: boolean) => {
      try {
        if (includeAccessibility && settings.windowCaptureEnabled)
          await bridge?.requestWindowCapturePermissions(true);
        await save({ windowCaptureIncludeAccessibility: includeAccessibility });
      } catch (error) {
        setSetupError(
          error instanceof Error ? error.message : "Could not request accessibility permissions.",
        );
      }
    },
    [bridge, save, settings.windowCaptureEnabled],
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
    shortcutCheckIdRef.current++;
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
    [bridge, keybindings],
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
    ? "Press your shortcut. Esc cancels."
    : candidateConflict
      ? `T3 Code already uses this for "${commandLabel(candidateConflict)}".`
      : shortcutCheck.status === "checking"
        ? "Checking shortcut…"
        : shortcutCheck.availability
          ? shortcutCheck.availability.available
            ? "Ready to save."
            : shortcutCheck.availability.message
          : state?.mode === "portal" && isModifierPairShortcut(displayShortcut)
            ? "Try a shortcut such as Ctrl+Shift+2."
            : windowCaptureShortcutStatus(state);

  const openSetup = async (requested: CaptureSetupStep | "resume" = "resume") => {
    if (!state || setupBusy) return;
    stopRecording();
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
    setSetupError(null);
    setSetupBusy(true);
    try {
      let current = await refreshState();
      if (!current) return;
      if (
        !settings.windowCaptureEnabled &&
        captureSetupInitialStep(current, requested) !== "access"
      ) {
        // Opening setup is the opt-in. Restore registration before resuming a
        // later step, just as Continue does on the access step.
        current = await save({ windowCaptureEnabled: true });
        if (!current) {
          // A settings write can succeed even if the following status check
          // fails. Keep Finish later available to turn capture back off.
          setWizard({ initialStep: "access", wasEnabled: false });
          return;
        }
      }
      setWizard({
        initialStep: captureSetupInitialStep(current, requested),
        wasEnabled: settings.windowCaptureEnabled,
      });
    } finally {
      setSetupBusy(false);
    }
  };

  const enableForSetup = async () => {
    if (setupBusy) return false;
    setSetupBusy(true);
    setSetupError(null);
    try {
      if (state?.mode === "direct")
        await bridge?.requestWindowCapturePermissions(settings.windowCaptureIncludeAccessibility);
      const nextState =
        settings.windowCaptureEnabled && !state?.message
          ? await refreshState()
          : await save({ windowCaptureEnabled: true });
      return nextState !== undefined && captureSetupAccessReady(nextState);
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Could not request capture permissions.",
      );
      return false;
    } finally {
      setSetupBusy(false);
    }
  };

  const closeSetup = async (completed: boolean) => {
    if (!wizard || setupBusy) return;
    setSetupBusy(true);
    try {
      if (
        settings.windowCaptureEnabled &&
        captureSetupShouldDisableOnClose(wizard.wasEnabled, completed)
      ) {
        if (!(await save({ windowCaptureEnabled: false }))) return;
      }
      stopRecording();
      setWizard(null);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not close capture setup.");
    } finally {
      setSetupBusy(false);
    }
  };

  const saveShortcut = async () => {
    if (!canSaveShortcut || setupBusy) return false;
    setSetupBusy(true);
    try {
      const saved = await save({ windowCaptureShortcut: candidate });
      return Boolean(saved?.shortcutRegistered || saved?.shortcutPending);
    } finally {
      setSetupBusy(false);
    }
  };

  const shortcutInput = (
    <Button
      type="button"
      variant={recording ? "secondary" : "outline"}
      disabled={setupBusy}
      aria-label={`Record window capture shortcut, currently ${!shortcutChanged && state?.shortcutLabel ? state.shortcutLabel : formatWindowCaptureShortcutLabel(displayShortcut)}`}
      aria-pressed={recording}
      data-keybinding-capture=""
      onClick={() => void startRecording()}
      onKeyDown={recordShortcut}
      onKeyUp={(event) => heldModifierCodesRef.current.delete(event.code)}
      onBlur={stopRecording}
    >
      {recording ? (
        "Press shortcut…"
      ) : state?.mode === "portal" && isModifierPairShortcut(displayShortcut) ? (
        "Choose shortcut"
      ) : !shortcutChanged && state?.shortcutLabel ? (
        state.shortcutLabel
      ) : (
        <WindowCaptureShortcutKeys shortcut={displayShortcut} />
      )}
    </Button>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="window-capture" title="Window Capture">
        {setupError && !wizard ? (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {setupError}
          </p>
        ) : null}
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...searchableSetting("window-capture-enabled")}
            description={windowCaptureDescription(state)}
            status={
              bridge
                ? setupBusy && !wizard
                  ? "Updating capture settings…"
                  : windowCaptureStatus(state, settings.windowCaptureEnabled)
                : undefined
            }
            control={
              <>
                {settings.windowCaptureEnabled ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={setupBusy}
                    onClick={() => void openSetup()}
                  >
                    {windowCaptureSetupButtonLabel(state)}
                  </Button>
                ) : null}
                <Switch
                  checked={settings.windowCaptureEnabled || Boolean(wizard)}
                  disabled={!captureAvailable || setupBusy}
                  aria-label="Enable window capture"
                  onCheckedChange={(checked) => {
                    if (checked) void openSetup();
                    else void save({ windowCaptureEnabled: false });
                  }}
                />
              </>
            }
          />
          {settings.windowCaptureEnabled && captureAvailable ? (
            <>
              <SettingsRow
                {...searchableSetting("window-capture-accessibility")}
                description="Include available accessibility text and UI structure with each screenshot."
                status={
                  windowCaptureAccessibilityUnavailableMessage(state) ??
                  "Available text depends on the app you're capturing."
                }
                control={
                  <Switch
                    checked={
                      !windowCaptureAccessibilityUnavailableMessage(state) &&
                      settings.windowCaptureIncludeAccessibility
                    }
                    disabled={
                      !captureAvailable ||
                      Boolean(windowCaptureAccessibilityUnavailableMessage(state))
                    }
                    aria-label="Include accessibility data in window captures"
                    onCheckedChange={(checked) => void saveIncludeAccessibility(checked)}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("window-capture-shortcut")}
                description={
                  state?.linuxBackend === "niri"
                    ? "Managed in your Niri config."
                    : state?.linuxBackend === "picker"
                      ? "Open the window picker from any app."
                      : "Capture from any app with a global shortcut."
                }
                status={state?.linuxBackend === "niri" ? undefined : shortcutStatus}
                control={
                  state?.linuxBackend === "niri" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      aria-expanded={showNiriShortcut}
                      aria-controls="niri-capture-shortcut"
                      onClick={() => setShowNiriShortcut((visible) => !visible)}
                    >
                      {showNiriShortcut ? "Hide instructions" : "Configure shortcut"}
                    </Button>
                  ) : (
                    <>
                      {shortcutInput}
                      {shortcutChanged ? (
                        <>
                          <Button
                            size="xs"
                            disabled={!canSaveShortcut || setupBusy}
                            onClick={() => void saveShortcut()}
                          >
                            {setupBusy ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={setupBusy}
                            onClick={() => {
                              stopRecording();
                              shortcutCheckIdRef.current++;
                              setCandidate(savedShortcut);
                              setShortcutCheck({ status: "idle", availability: null });
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : state?.mode === "portal" && !isModifierPairShortcut(savedShortcut) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={setupBusy || state.shortcutPending}
                          onClick={() => void setup("retry-shortcut")}
                        >
                          Shortcut permissions
                        </Button>
                      ) : null}
                    </>
                  )
                }
              >
                {state?.linuxBackend === "niri" && showNiriShortcut ? (
                  <div id="niri-capture-shortcut" className="mt-3 pb-3.5">
                    <NiriCaptureShortcutInstructions binding={state.shortcutBinding} />
                  </div>
                ) : null}
              </SettingsRow>
              <SettingsRow
                {...searchableSetting("window-capture-sound")}
                description="Choose the sound played when capture starts."
                control={
                  <Menu>
                    <MenuTrigger
                      aria-label={"Window capture sound: " + soundLabel}
                      className={cn(selectTriggerVariants({ size: "sm" }), "w-auto min-w-0")}
                      disabled={!captureAvailable}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">
                        {soundSelection === "off" ? (
                          "Off"
                        ) : soundSelection === "soft-pop" ? (
                          <>
                            Whoosh <span className="text-muted-foreground">(Default)</span>
                          </>
                        ) : (
                          "Click"
                        )}
                      </span>
                      <ChevronDownIcon className="-me-1 size-3 shrink-0 opacity-50" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuRadioGroup
                        onValueChange={(value) =>
                          void save(windowCaptureSoundPatch(value as WindowCaptureSoundSelection))
                        }
                        value={soundSelection}
                      >
                        <MenuRadioItem closeOnClick value="off">
                          Off
                        </MenuRadioItem>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem
                            className={soundOptionItemClassName}
                            closeOnClick
                            value="soft-pop"
                          >
                            Whoosh <span className="text-muted-foreground">(Default)</span>
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Whoosh"
                            className={soundPreviewClassName}
                            closeOnClick={false}
                            onClick={() => playWindowCaptureSound("soft-pop")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem
                            className={soundOptionItemClassName}
                            closeOnClick
                            value="camera-shutter"
                          >
                            Click
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Click"
                            className={soundPreviewClassName}
                            closeOnClick={false}
                            onClick={() => playWindowCaptureSound("camera-shutter")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
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
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
      {wizard && state ? (
        <WindowCaptureSetupDialog
          state={state}
          initialStep={wizard.initialStep}
          wasEnabled={wizard.wasEnabled}
          busy={setupBusy}
          error={setupError}
          shortcutInput={shortcutInput}
          shortcutStatus={shortcutStatus}
          shortcutChanged={shortcutChanged}
          canSaveShortcut={canSaveShortcut}
          onSaveShortcut={saveShortcut}
          onEnable={enableForSetup}
          onAction={setup}
          onRefresh={() => {
            setSetupError(null);
            return refreshState();
          }}
          onClose={closeSetup}
          onLeaveStep={stopRecording}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
