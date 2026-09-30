import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  openServerBrowserInstallPrompt,
  type BrowserSettingsReadError,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
  if (result._tag === "Failure" && openServerBrowserInstallPrompt(input.threadRef, result.cause)) {
    return AsyncResult.success(undefined);
  }
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
