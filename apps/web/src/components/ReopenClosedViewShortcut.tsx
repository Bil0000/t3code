import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClosedViewStore } from "../closedViewStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { effectiveShortcutsForCommand, resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { reopenClosedView } from "../reopenClosedView";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { toastManager } from "./ui/toast";

export function ReopenClosedViewShortcut() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const target = resolveThreadRouteTarget(params);
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const threadRef =
    target?.kind === "server"
      ? target.threadRef
      : draft
        ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
        : null;
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const previewOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "preview",
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasHistory = useClosedViewStore((state) => state.entries.length > 0);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const openTerminal = useAtomCommand(terminalEnvironment.open);
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const pending = useRef(Promise.resolve());

  const reopenNext = useEffectEvent(async () => {
    for (const entry of useClosedViewStore.getState().entries) {
      const ref = entry.threadRef;
      const globalPullRequests = scopedThreadKey(ref) === scopedThreadKey(PULL_REQUESTS_PANEL_REF);
      if (!globalPullRequests) {
        const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
        if (!catalog.entries.has(ref.environmentId)) {
          if (!catalog.isReady) return;
          useClosedViewStore.getState().remove(entry.id);
          continue;
        }
      }
      const drafts = useComposerDraftStore.getState();
      const draftThread = drafts.getDraftThreadByRef(ref);
      const thread = globalPullRequests ? null : readThreadShell(ref);
      if (!globalPullRequests && thread === null && draftThread === null) {
        if (
          appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live"
        )
          continue;
        return;
      }
      const panels = useRightPanelStore.getState();
      const panel = selectThreadRightPanelState(panels.byThreadKey, ref);
      const terminals = selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        ref,
      );
      const alreadyOpen =
        (entry.kind === "panel" && (panel.isOpen || panel.surfaces.length === 0)) ||
        (entry.kind === "panel-tab" &&
          panel.isOpen &&
          panel.surfaces.some((surface) => surface.id === entry.surface.id)) ||
        (entry.kind === "browser" &&
          panel.surfaces.some(
            (surface) => surface.kind === "preview" && surface.resourceId === entry.snapshot.tabId,
          )) ||
        (entry.kind === "terminal-drawer" && terminals.terminalOpen) ||
        (entry.kind === "terminal" && terminals.terminalIds.includes(entry.terminalId));
      if (alreadyOpen) {
        useClosedViewStore.getState().remove(entry.id);
        continue;
      }
      const owner = thread ?? draftThread;
      const project = owner
        ? readProject(scopeProjectRef(ref.environmentId, owner.projectId))
        : null;
      const worktreePath = owner?.worktreePath ?? null;
      const workspace = project
        ? {
            cwd: projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }),
            ...(worktreePath === null ? {} : { worktreePath }),
            env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
          }
        : null;
      if (!(await reopenClosedView(entry, { openPreview, openTerminal, closeTerminal, workspace })))
        return;
      if (globalPullRequests) {
        const surface = selectSelectedRightPanelSurface(
          useRightPanelStore.getState().byThreadKey,
          ref,
        );
        await navigate({
          to: "/pull-requests",
          search: (previous) => {
            const next = {
              ...previous,
              involvement: previous.involvement ?? "all",
              state: previous.state ?? "open",
            };
            delete next.repository;
            delete next.number;
            delete next.selectedProjectId;
            delete next.selectedHost;
            delete next.selectedEnvironmentId;
            return {
              ...next,
              ...(surface?.kind === "pull-request"
                ? {
                    repository: surface.repository,
                    number: surface.number,
                    selectedProjectId: surface.projectId as ProjectId,
                    ...(surface.host === undefined ? {} : { selectedHost: surface.host }),
                    ...(surface.environmentId === undefined
                      ? {}
                      : { selectedEnvironmentId: surface.environmentId as EnvironmentId }),
                  }
                : {}),
            };
          },
        });
      } else {
        const draftId = thread === null ? drafts.getDraftIdByRef(ref) : null;
        if (draftId !== null)
          await navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) });
        else
          await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      }
      useClosedViewStore.getState().remove(entry.id);
      return;
    }
  });

  const enqueueReopen = useEffectEvent(() => {
    pending.current = pending.current
      .then(() => reopenNext())
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reopen view",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isCommandPaletteOpen() ||
        useClosedViewStore.getState().entries.length === 0 ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "rightPanel.reopenClosed") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) enqueueReopen();
    };
    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "reopen-closed" && !isCommandPaletteOpen()) enqueueReopen();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, previewOpen, terminalOpen]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.setReopenClosedShortcuts) return;
    void preview
      .setReopenClosedShortcuts(
        hasHistory
          ? effectiveShortcutsForCommand(keybindings, "rightPanel.reopenClosed", {
              context: {
                previewFocus: true,
                previewOpen: true,
                terminalFocus: false,
                terminalOpen,
                editableFocus: false,
                modelPickerOpen: false,
                isDesktop: true,
                isWeb: false,
              },
            })
          : [],
      )
      .catch(() => undefined);
    return () => {
      void preview.setReopenClosedShortcuts?.([]).catch(() => undefined);
    };
  }, [hasHistory, keybindings, terminalOpen]);

  return null;
}
