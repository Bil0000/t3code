import {
  isModifierPairShortcut,
  type DesktopWindowCaptureSetupAction,
  type DesktopWindowCaptureState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { WizardSteps } from "../ui/wizard-steps";
import {
  captureSetupAccessReady,
  captureSetupBackend,
  captureSetupCheckMessage,
  captureSetupDesktopName,
  captureSetupInitialStep,
  captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./WindowCaptureSetupDialog.logic";

const SETUP_STEPS = [
  { id: "access", label: "Access" },
  { id: "shortcut", label: "Shortcut" },
] as const;

const GNOME_ACCESS_COPY = {
  "not-installed": {
    title: "Install the extension",
    description:
      "The T3 Code GNOME extension lets you capture other windows and bring them into your draft. Sign out once after installing.",
  },
  "restart-required": {
    title: "Extension installed",
    description: "Save your work, then sign out and back in. Your setup will be waiting here.",
  },
  "update-required": {
    title: "Update the extension",
    description: "Install the update, then sign out and back in.",
  },
  "extensions-disabled": {
    title: "Allow GNOME extensions",
    description: "Open GNOME Extensions and turn on extensions, then check again.",
  },
  disabled: {
    title: "Enable the extension",
    description: "Enable T3 Code Window Capture to start capturing windows.",
  },
  enabled: {
    title: "Capture is ready",
    description: "Next, choose your shortcut.",
  },
  unsupported: {
    title: "Automatic capture isn't available",
    description: "Use Capture window from the command palette to choose a window.",
  },
  error: {
    title: "Couldn't set up the extension",
    description: "Check T3 Code Window Capture in GNOME Extensions, then try again.",
  },
};

export function WindowCaptureSetupDialog({
  state,
  initialStep,
  wasEnabled,
  busy: actionBusy,
  error,
  shortcutInput,
  shortcutStatus,
  shortcutChanged,
  canSaveShortcut,
  onSaveShortcut,
  onEnable,
  onAction,
  onRefresh,
  onClose,
  onLeaveStep,
}: {
  state: DesktopWindowCaptureState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: ReactNode;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopWindowCaptureSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopWindowCaptureState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const [step, setStep] = useState(() => captureSetupInitialStep(state, initialStep));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const busy = actionBusy || checking || configBusy;
  const backend = captureSetupBackend(state);
  const configShortcut = backend === "niri" || backend === "hyprland";
  const desktop = captureSetupDesktopName(state);
  const extension = state.gnomeExtension;
  const helper = backend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
  const helperBackend = backend === "kde" || backend === "hyprland";
  const installHelper = backend === "hyprland" ? "install-hyprland-helper" : "install-kde-helper";
  const removeHelper = backend === "hyprland" ? "remove-hyprland-helper" : "remove-kde-helper";
  const accessReady = captureSetupAccessReady(state);
  const shortcutReady = captureSetupShortcutReady(state, shortcutChanged);
  const install = extension?.status === "not-installed" || extension?.status === "update-required";
  const enable = extension?.status === "disabled";
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setChecked(false);
    setStep(next);
  };
  const checkAgain = async () => {
    if (busy) return;
    setChecking(true);
    setChecked(false);
    try {
      setChecked((await onRefresh()) !== undefined);
    } finally {
      setChecking(false);
    }
  };
  const accessCopy = state.message
    ? {
        title: "Let's try that again",
        description: "Couldn't check window capture. Try again to continue.",
      }
    : backend === "gnome" && extension
      ? extension.status === "enabled" && !accessReady
        ? {
            title: "Check capture access",
            description: "The extension isn't ready yet. Try again in a moment.",
          }
        : GNOME_ACCESS_COPY[extension.status]
      : helperBackend
        ? helper?.status === "ready"
          ? {
              title: "Capture is ready",
              description: "Next, choose your shortcut.",
            }
          : helper?.status === "error"
            ? {
                title: "Let's fix capture access",
                description: "Try reinstalling the capture helper, then check again.",
              }
            : {
                title:
                  helper?.status === "update-required"
                    ? "Update the capture helper"
                    : "Allow window capture",
                description:
                  "T3 Code's capture helper lets you capture other apps and return to your draft. It's included with T3 Code.",
              }
        : backend === "niri"
          ? {
              title: "Capture is ready",
              description: "Next, choose your shortcut.",
            }
          : backend === "picker"
            ? {
                title: "Choose a window each time",
                description:
                  "Your desktop doesn't support automatic capture. You'll choose the window to capture instead.",
              }
            : {
                title: "Allow window capture",
                description:
                  backend === "portal"
                    ? "Your desktop may ask for permission when you first capture."
                    : "Allow access when prompted to start capturing windows.",
              };
  const title = step === "access" ? accessCopy.title : "Choose your shortcut";
  const description =
    step === "access"
      ? accessCopy.description
      : configShortcut
        ? "Click the shortcut, then press the keys you want."
        : state.mode === "portal"
          ? "Choose your keys, then approve the permission prompt if asked."
          : "Use both Shift keys, or record a different shortcut.";
  const stepIndex = SETUP_STEPS.findIndex(({ id }) => id === step);
  const details = [
    ...new Set(
      [
        error,
        ...(step === "access"
          ? [
              state.message,
              backend === "gnome" &&
              (extension?.status === "error" || extension?.status === "unsupported")
                ? extension.message
                : null,
              helperBackend && helper?.status === "error" ? helper.message : null,
            ]
          : []),
      ].filter((detail) => detail !== null),
    ),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onClose(false);
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {desktop ? `Set up capture for ${desktop}` : "Set up window capture"}
          </DialogTitle>
          <WizardSteps
            steps={SETUP_STEPS.map((item, index) => ({ ...item, disabled: index > stepIndex }))}
            currentStep={step}
            disabled={busy}
            onStepSelect={(next) => {
              if (next !== step) changeStep(next);
            }}
          />
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 text-sm">
            <div className="space-y-2" aria-live="polite">
              <h3 className="flex items-center gap-2 font-medium">{title}</h3>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {step === "access" ? (
              <>
                <p
                  role="status"
                  aria-atomic="true"
                  className={
                    checked && !busy && !error ? "text-xs text-muted-foreground" : "sr-only"
                  }
                >
                  {checked && !busy && !error ? captureSetupCheckMessage(state) : null}
                </p>
                {helperBackend && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction(installHelper)}
                  >
                    Reinstall helper
                  </Button>
                ) : null}
              </>
            ) : configShortcut ? (
              <CaptureShortcutConfig
                state={state}
                disabled={actionBusy || checking || !accessReady}
                onBusyChange={setConfigBusy}
                onSaved={onRefresh}
                onComplete={() => onClose(true)}
              />
            ) : (
              <div className="space-y-3">
                {shortcutInput}
                {shortcutStatus ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {shortcutStatus}
                  </p>
                ) : null}
                {!shortcutChanged &&
                !state.shortcutRegistered &&
                !state.shortcutPending &&
                !isModifierPairShortcut(state.shortcut) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onAction("retry-shortcut")}
                  >
                    {state.mode === "portal" ? "Shortcut permissions" : "Try again"}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                Capture needs attention. Go back to check access.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                Couldn't finish this step. Try again or check Advanced for help.
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Advanced</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>Included with T3 Code. No download needed.</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      Disable extension
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      Remove capture helper
                    </Button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {step !== "access" ? (
            <Button variant="ghost" disabled={busy} onClick={() => changeStep("access")}>
              Back
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? "Close" : "Finish later"}
          </Button>
          {step === "access" ? (
            helperBackend && !accessReady && helper?.status !== "ready" ? (
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void (helper?.status === "error" ? checkAgain() : onAction(installHelper))
                }
              >
                {checking
                  ? "Checking…"
                  : busy
                    ? "Installing…"
                    : helper?.status === "error"
                      ? "Check again"
                      : helper?.status === "update-required"
                        ? "Update helper"
                        : "Install helper"}
              </Button>
            ) : backend === "gnome" && !accessReady && extension?.status !== "enabled" ? (
              <Button
                disabled={busy}
                aria-busy={checking}
                onClick={() =>
                  void (install
                    ? onAction("install-extension")
                    : enable
                      ? onAction("enable-extension")
                      : checkAgain())
                }
              >
                {checking
                  ? "Checking…"
                  : busy
                    ? install
                      ? "Installing…"
                      : enable
                        ? "Enabling…"
                        : "Working…"
                    : install
                      ? extension?.status === "update-required"
                        ? "Update extension"
                        : "Install extension"
                      : enable
                        ? "Enable extension"
                        : "Check again"}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy
                  ? "Working…"
                  : backend === "direct"
                    ? "Allow capture"
                    : !accessReady
                      ? "Try again"
                      : "Continue"}
              </Button>
            )
          ) : !configShortcut ? (
            <Button
              disabled={
                busy || !accessReady || (shortcutChanged ? !canSaveShortcut : !shortcutReady)
              }
              onClick={async () => {
                if (!shortcutChanged || (await onSaveShortcut())) await onClose(true);
              }}
            >
              {busy ? "Saving…" : shortcutChanged ? "Save and finish" : "Done"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
