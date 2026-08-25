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
  return (
    <KbdGroup>
      <span className="sr-only">{formatWindowCaptureShortcutLabel(shortcut, platform)}</span>
      {windowCaptureShortcutKeyLabels(shortcut, platform).map((key, index) => (
        <Fragment key={key + "-" + index}>
          {index > 0 ? (
            <span aria-hidden className="text-xs text-muted-foreground">
              +
            </span>
          ) : null}
          <Kbd aria-hidden>{key}</Kbd>
        </Fragment>
      ))}
    </KbdGroup>
  );
}
