import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TerminalCloseInput, TerminalOpenInput } from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";

import type { OpenPreviewMutation } from "./browser/openFileInPreview";
import { useClosedViewStore, type ClosedView } from "./closedViewStore";
import { openPreviewSession } from "./components/preview/openPreviewSession";
import { useRightPanelStore } from "./rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "./terminalUiStateStore";

export async function reopenClosedView(
  view: ClosedView,
  options: {
    openPreview: OpenPreviewMutation;
    openTerminal: (request: {
      environmentId: EnvironmentId;
      input: TerminalOpenInput;
    }) => Promise<AtomCommandResult<unknown, unknown>>;
    closeTerminal: (request: {
      environmentId: EnvironmentId;
      input: TerminalCloseInput;
    }) => Promise<AtomCommandResult<unknown, unknown>>;
    workspace: Pick<TerminalOpenInput, "cwd" | "worktreePath" | "env"> | null;
  },
): Promise<boolean> {
  const panels = useRightPanelStore.getState();
  const terminals = useTerminalUiStateStore.getState();
  const ref = view.threadRef;

  if (view.kind === "panel") {
    if (!panels.byThreadKey[scopedThreadKey(ref)]?.surfaces.length) return false;
    panels.show(ref);
    return true;
  }
  if (view.kind === "terminal-drawer") {
    const state = selectThreadTerminalUiState(terminals.terminalUiStateByThreadKey, ref);
    if (state.terminalIds.length > 0) {
      terminals.setTerminalOpen(ref, true);
      return true;
    }
  }
  if (view.kind === "browser") {
    const url = view.snapshot.navStatus._tag === "Idle" ? undefined : view.snapshot.navStatus.url;
    const result = await openPreviewSession({
      openPreview: options.openPreview,
      threadRef: ref,
      ...(url === undefined ? {} : { url }),
      ...(view.snapshot.viewport === undefined ? {} : { viewport: view.snapshot.viewport }),
      ...(view.snapshot.profileId === undefined ? {} : { profileId: view.snapshot.profileId }),
    });
    if (result._tag === "Failure") return false;
    panels.openBrowser(ref, result.value.tabId);
    return true;
  }
  if (
    view.kind === "terminal" ||
    view.kind === "terminal-drawer" ||
    (view.kind === "panel-tab" && view.surface.kind === "terminal")
  ) {
    if (!options.workspace?.cwd) return false;
    const surface = view.kind === "panel-tab" ? view.surface : null;
    const count = surface?.kind === "terminal" ? surface.terminalIds.length : 1;
    if (count === 0) return false;
    const ids: string[] = [];
    const reservedIds: string[] = [];
    const drawerWasOpen = selectThreadTerminalUiState(
      terminals.terminalUiStateByThreadKey,
      ref,
    ).terminalOpen;
    const usedIds = [
      ...selectThreadTerminalUiState(terminals.terminalUiStateByThreadKey, ref).terminalIds,
      ...(terminals.suppressedTerminalIdsByThreadKey[scopedThreadKey(ref)] ?? []),
      ...selectThreadRightPanelTerminals(ref),
      ...useClosedViewStore
        .getState()
        .entries.filter((entry) => scopedThreadKey(entry.threadRef) === scopedThreadKey(ref))
        .flatMap((entry) =>
          entry.kind === "terminal"
            ? [entry.terminalId]
            : entry.kind === "panel-tab" && entry.surface.kind === "terminal"
              ? entry.surface.terminalIds
              : [],
        ),
      ...(view.kind === "terminal" ? [view.terminalId] : []),
      ...(surface?.kind === "terminal" ? surface.terminalIds : []),
    ];
    for (let index = 0; index < count; index += 1) {
      const id = nextTerminalId(usedIds);
      usedIds.push(id);
      terminals.ensureTerminal(ref, id, { active: false, open: false });
      if (!drawerWasOpen) terminals.setTerminalOpen(ref, false);
      reservedIds.push(id);
    }
    for (const id of reservedIds) {
      const result = await options.openTerminal({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          terminalId: id,
          ...options.workspace,
        },
      });
      if (result._tag === "Failure") {
        for (const reservedId of reservedIds) terminals.closeTerminal(ref, reservedId);
        for (const openedId of ids) {
          await options.closeTerminal({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, terminalId: openedId, deleteHistory: true },
          });
        }
        return false;
      }
      ids.push(id);
    }
    if (view.kind === "terminal-drawer" || (view.kind === "terminal" && !view.panelSurfaceId)) {
      terminals.ensureTerminal(ref, ids[0]!, { open: true });
    } else {
      const existingPanel =
        view.kind === "terminal"
          ? useRightPanelStore
              .getState()
              .byThreadKey[scopedThreadKey(ref)]?.surfaces.find(
                (entry) => entry.id === view.panelSurfaceId && entry.kind === "terminal",
              )
          : null;
      if (existingPanel) {
        panels.splitTerminal(
          ref,
          existingPanel.id,
          ids[0]!,
          view.kind === "terminal" ? view.splitDirection : undefined,
        );
      } else {
        panels.openTerminal(ref, ids[0]!);
        for (const id of ids.slice(1)) {
          panels.splitTerminal(
            ref,
            `terminal:${ids[0]}`,
            id,
            surface?.kind === "terminal" ? surface.splitDirection : undefined,
          );
        }
        if (surface?.kind === "terminal") {
          const activeIndex = Math.max(0, surface.terminalIds.indexOf(surface.activeTerminalId));
          panels.activateTerminal(ref, `terminal:${ids[0]}`, ids[activeIndex]!);
        }
      }
      terminals.reconcileTerminalIds(
        ref,
        selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          ref,
        ).terminalIds.filter((id) => !reservedIds.includes(id)),
      );
    }
    return true;
  }
  const surface = view.surface;
  switch (surface.kind) {
    case "preview":
      if (surface.resourceId !== null) return false;
      panels.openBrowser(ref, null);
      break;
    case "terminal":
      return false;
    case "file":
      if (surface.attachment) panels.openAttachment(ref, surface.attachment);
      else panels.openFile(ref, surface.relativePath, surface.revealLine ?? undefined);
      break;
    case "device":
      if (surface.target) {
        panels.openDevice(ref, surface.target);
        if (surface.title) panels.renameDevice(ref, surface.id, surface.title);
      } else panels.open(ref, "device");
      break;
    case "pull-request":
      panels.openPullRequest(ref, surface);
      break;
    default:
      panels.open(ref, surface.kind);
  }
  return true;
}

function selectThreadRightPanelTerminals(ref: ClosedView["threadRef"]): string[] {
  return (
    useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(ref)]?.surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      ) ?? []
  );
}
