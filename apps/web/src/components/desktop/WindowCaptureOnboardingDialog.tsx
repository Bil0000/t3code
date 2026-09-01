import type { DesktopWindowCaptureState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CameraIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { getDesktopWindowCaptureBridge } from "../../lib/desktopWindowCapture";
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
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { windowCaptureOnboardingContent } from "../settings/WindowCaptureSettings.logic";
import { WindowCaptureShortcutKeys } from "./WindowCaptureShortcutKeys";

export function WindowCaptureOnboardingDialog() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const navigate = useNavigate();
  const bridge = getDesktopWindowCaptureBridge();
  const [captureState, setCaptureState] = useState<DesktopWindowCaptureState | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .getWindowCaptureState()
      .then((state) => {
        if (active) setCaptureState(state);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  const content = windowCaptureOnboardingContent(captureState);
  const open =
    settingsHydrated &&
    Boolean(bridge) &&
    content !== null &&
    !settings.windowCaptureOnboardingDismissed;

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
          <div className="flex size-11 items-center justify-center rounded-xl border border-border/70 bg-muted/60">
            <CameraIcon className="size-5 text-muted-foreground" />
          </div>
          <DialogTitle>Capture any window</DialogTitle>
          <DialogDescription>
            Press the global shortcut from any app. T3 Code captures that window and adds it to your
            current draft with its app name and icon.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/50 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              <SparklesIcon className="size-4 text-muted-foreground" />
              {content === "choose-shortcut" ? "Shortcut" : "Default shortcut"}
            </span>
            {content === "show-shortcut" ? (
              <WindowCaptureShortcutKeys shortcut={settings.windowCaptureShortcut} />
            ) : (
              <span className="text-muted-foreground text-xs">Choose in Settings</span>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
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
