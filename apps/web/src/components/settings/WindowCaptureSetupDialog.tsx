import {
  isModifierPairShortcut,
  type DesktopWindowCaptureSetupAction,
  type DesktopWindowCaptureState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { NiriCaptureShortcutInstructions } from "./NiriCaptureShortcutInstructions";
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
      "Install the T3 Code GNOME extension to capture windows from other apps and animate them into your draft. You'll need to sign out once after installing.",
  },
  "restart-required": {
    title: "Extension installed",
    description: "Save your work, then sign out of GNOME and back in. Reopen setup to continue.",
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
    title: "The extension is ready",
    description: "Next, choose a shortcut to capture from another app.",
  },
  unsupported: {
    title: "GNOME version not supported",
    description: "You can still use Capture window from the command palette.",
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
  const busy = actionBusy || checking;
  const backend = captureSetupBackend(state);
  const desktop = captureSetupDesktopName(state);
  const extension = state.gnomeExtension;
  const helper = state.kdeHelper;
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
        title: "Couldn't check capture access",
        description: desktop
          ? `Try again to check capture access on ${desktop}.`
          : "Try again to check whether window capture is available.",
      }
    : backend === "gnome" && extension
      ? extension.status === "enabled" && !accessReady
        ? {
            title: "Check capture access",
            description: "The extension isn't responding yet. Try again to check it.",
          }
        : GNOME_ACCESS_COPY[extension.status]
      : backend === "kde"
        ? helper?.status === "ready"
          ? {
              title: "KDE capture is ready",
              description: "Next, choose a shortcut to capture the window you're using.",
            }
          : helper?.status === "error"
            ? { title: "Check KDE capture access", description: helper.message }
            : {
                title:
                  helper?.status === "update-required"
                    ? "Update the capture helper"
                    : "Allow capture on KDE Plasma",
                description:
                  "Install the bundled T3 Code helper to capture windows, show capture effects, and return to your draft. No download or sign-out needed.",
              }
        : backend === "niri"
          ? {
              title: "Niri is ready",
              description: "Next, add a capture shortcut to your Niri config.",
            }
          : backend === "picker"
            ? {
                title: "Manual capture only",
                description:
                  "Automatic capture isn't available on this desktop. Your shortcut will open a picker so you can choose a window instead.",
              }
            : {
                title: "Allow window capture",
                description:
                  backend === "portal"
                    ? "Your desktop may ask for permission when you first capture."
                    : "Approve the system permission requests to continue.",
              };
  const title = step === "access" ? accessCopy.title : "Choose your shortcut";
  const description =
    step === "access"
      ? accessCopy.description
      : backend === "niri"
        ? "Add this binding to your Niri config, then save it."
        : state.mode === "portal"
          ? "Choose a shortcut to capture from another app. Approve your desktop's permission prompt if one appears."
          : "Use both Shift keys, or click below to choose another shortcut.";
  const stepIndex = SETUP_STEPS.findIndex(({ id }) => id === step);

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
                {backend === "gnome" &&
                (extension?.status === "error" || extension?.status === "unsupported") ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Details</summary>
                    <p className="mt-2">{extension.message}</p>
                  </details>
                ) : null}
                {state.message ? (
                  <p role="status" className="text-muted-foreground">
                    {state.message}
                  </p>
                ) : null}
                <p
                  role="status"
                  aria-atomic="true"
                  className={
                    checked && !busy && !error ? "text-xs text-muted-foreground" : "sr-only"
                  }
                >
                  {checked && !busy && !error ? captureSetupCheckMessage(state) : null}
                </p>
                {backend === "gnome" && extension?.status === "enabled" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void onAction("disable-extension")}
                  >
                    Disable extension
                  </Button>
                ) : null}
                {backend === "kde" && helper?.status !== "not-installed" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void onAction("remove-kde-helper")}
                  >
                    Remove capture helper
                  </Button>
                ) : null}
                {backend === "kde" && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction("install-kde-helper")}
                  >
                    Reinstall helper
                  </Button>
                ) : null}
              </>
            ) : backend === "niri" ? (
              <NiriCaptureShortcutInstructions binding={state.shortcutBinding} disabled={busy} />
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
                    {state.mode === "portal" ? "Shortcut permissions" : "Retry shortcut request"}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                Capture access changed. Go back to Access to check it.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
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
            backend === "kde" && !accessReady && helper?.status !== "ready" ? (
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void (helper?.status === "error" ? checkAgain() : onAction("install-kde-helper"))
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
          ) : (
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
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
