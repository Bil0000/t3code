import type { WindowCaptureShortcut } from "@t3tools/contracts";
import { windowCaptureShortcutKeyLabels } from "../../lib/windowCaptureShortcut";
import { Kbd, KbdGroup } from "../ui/kbd";

export function WindowCaptureShortcutKeys({
  shortcut,
  platform = navigator.platform,
}: {
  shortcut: WindowCaptureShortcut;
  platform?: string;
}) {
  const seenLabels = new Map<string, number>();
  return (
    <KbdGroup>
      {windowCaptureShortcutKeyLabels(shortcut, platform).map((label) => {
        const seen = seenLabels.get(label) ?? 0;
        seenLabels.set(label, seen + 1);
        return (
          <Kbd aria-hidden className="min-w-6 justify-center px-1.5" key={`${label}-${seen}`}>
            {label}
          </Kbd>
        );
      })}
    </KbdGroup>
  );
}
