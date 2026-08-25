import type { WindowCaptureShortcut } from "@t3tools/contracts";
import { Fragment } from "react";

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
  let first = true;

  return (
    <KbdGroup>
      <span className="sr-only">{formatWindowCaptureShortcutLabel(shortcut, platform)}</span>
      {windowCaptureShortcutKeyLabels(shortcut, platform).map((key) => {
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        const separator = !first;
        first = false;
        return (
          <Fragment key={key + "-" + occurrence}>
            {separator ? (
              <span aria-hidden className="text-xs text-muted-foreground">
                +
              </span>
            ) : null}
            <Kbd aria-hidden>{key}</Kbd>
          </Fragment>
        );
      })}
    </KbdGroup>
  );
}
