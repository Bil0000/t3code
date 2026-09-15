import { useEffect, useEffectEvent } from "react";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { formatShortcutLabel } from "../../keybindings";
import { mouseShortcutEvent } from "../../shortcutInput";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";

export function ShortcutCapture({
  value,
  recording,
  label,
  onChange,
  onRecordingChange,
}: {
  value: string;
  recording: boolean;
  label: string;
  onChange: (key: string) => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const record = useEffectEvent(onChange);
  const stopRecording = useEffectEvent(() => onRecordingChange(false));
  useEffect(() => {
    if (!recording) return;
    const claimed = new Set<number>();
    const onMouseDown = (event: MouseEvent) => {
      if (
        event.button === 0 &&
        event.target instanceof Element &&
        event.target.closest("button, select")
      )
        return;
      const input = mouseShortcutEvent(event);
      const shortcut = keybindingFromKeyboardEvent(
        { ...input, code: "" },
        navigator.platform,
        true,
      );
      if (!shortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      claimed.add(event.button);
      record(shortcut);
    };
    const onMouseEnd = (event: MouseEvent) => {
      if (!claimed.has(event.button)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "auxclick" || event.type === "click") claimed.delete(event.button);
    };
    const onBlur = () => stopRecording();
    window.addEventListener("mousedown", onMouseDown, true);
    for (const type of ["mouseup", "click", "auxclick", "contextmenu"] as const)
      window.addEventListener(type, onMouseEnd, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      for (const type of ["mouseup", "click", "auxclick", "contextmenu"] as const)
        window.removeEventListener(type, onMouseEnd, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording]);
  const shortcut = parseKeybindingShortcut(value);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {recording ? (
        <Input
          data-keybinding-capture=""
          autoFocus
          readOnly
          aria-label={`Keybinding for ${label}`}
          value={shortcut ? formatShortcutLabel(shortcut) : ""}
          placeholder="Press a key or mouse button"
          className="w-52 border-primary/70 bg-primary/5"
          size="sm"
          onBlur={() => onRecordingChange(false)}
          onKeyDown={(event) => {
            if (event.key === "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              onRecordingChange(false);
              return;
            }
            if (event.repeat || event.nativeEvent.isComposing) return;
            const key = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, true);
            if (key) onChange(key);
          }}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRecordingChange(true)}
          aria-label={`Edit shortcut for ${label}`}
        >
          {shortcut ? formatShortcutLabel(shortcut) : "Record shortcut"}
        </Button>
      )}
    </div>
  );
}
