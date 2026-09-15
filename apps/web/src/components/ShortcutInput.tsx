import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../state/server";
import { installShortcutInput } from "../shortcutInput";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";

export function ShortcutInput() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const installed = useRef<ReturnType<typeof installShortcutInput> | null>(null);
  const read = useEffectEvent(() => ({
    keybindings,
    context: {
      terminalFocus: isTerminalFocused(),
      terminalOpen: threadRef
        ? selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            threadRef,
          ).terminalOpen
        : false,
      previewFocus: isPreviewFocused(),
      previewOpen: threadRef
        ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
        : false,
      modelPickerOpen: isModelPickerOpen(),
    },
  }));
  useLayoutEffect(() => {
    const input = installShortcutInput(window, read);
    installed.current = input;
    return () => input.dispose();
  }, []);
  useEffect(() => installed.current?.clear(), [keybindings, pathname]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        document.activeElement?.closest("[data-keybinding-capture]")
      )
        return;
      if (
        resolveShortcutCommand(event, keybindings, { context: read().context }) !==
        "usage.openLimits"
      )
        return;
      event.preventDefault();
      void navigate({ to: "/usage", search: { tab: "limits" } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate]);
  return null;
}
