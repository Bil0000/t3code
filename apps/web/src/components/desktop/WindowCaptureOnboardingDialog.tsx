import { CameraIcon, SparklesIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { formatShortcutLabel } from "../../keybindings";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd } from "../ui/kbd";

export function WindowCaptureOnboardingDialog() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const navigate = useNavigate();
  const open =
    settingsHydrated && Boolean(window.desktopBridge) && !settings.windowCaptureOnboardingDismissed;

  const close = () => {
    void updateSettings({ windowCaptureOnboardingDismissed: true });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl border border-border bg-muted">
            <CameraIcon className="size-5" />
          </div>
          <DialogTitle>Capture any window</DialogTitle>
          <DialogDescription>
            Press the global shortcut from any app. T3 Code captures that window and adds it to your
            current draft with its app name and icon.
          </DialogDescription>
        </DialogHeader>
        <div className="mx-6 flex items-center justify-between rounded-xl border border-border bg-muted/50 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4 text-muted-foreground" />
            Default shortcut
          </span>
          <Kbd>{formatShortcutLabel(settings.windowCaptureShortcut)}</Kbd>
        </div>
        <DialogFooter className="mt-6">
          <Button type="button" variant="ghost" onClick={close}>
            Not now
          </Button>
          <Button
            type="button"
            onClick={() => {
              close();
              void navigate({ to: "/settings/window-capture" });
            }}
          >
            Set up capture
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
