import type { WindowCaptureShortcut } from "@t3tools/contracts";

import {
  formatWindowCaptureShortcutLabel,
  windowCaptureShortcutKeyLabels,
} from "../../lib/windowCaptureShortcut";
import { Kbd, KbdGroup } from "../ui/kbd";

export function WindowCaptureShortcutKeys({
  shortcut,
  platform = navigator.platform,
}: {
  shortcut: WindowCaptureShortcut;
  platform?: string;
}) {
  const occurrences = new Map<string, number>();

  return (
    <KbdGroup aria-label={formatWindowCaptureShortcutLabel(shortcut, platform)}>
      {windowCaptureShortcutKeyLabels(shortcut, platform).map((key) => {
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        return (
          <Kbd key={key + "-" + occurrence} aria-hidden>
            {key}
          </Kbd>
        );
      })}
    </KbdGroup>
  );
}
