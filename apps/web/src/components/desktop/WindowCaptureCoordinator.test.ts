import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { resolveExistingWindowCaptureTarget } from "./WindowCaptureCoordinator";

const environmentId = EnvironmentId.make("window-capture-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("window-capture-project"));

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

describe("window capture target resolution", () => {
  it("follows a draft to its promoted server thread", () => {
    const draftId = DraftId.make("window-capture-draft");
    const promotedRef = scopeThreadRef(
      environmentId,
      ThreadId.make("window-capture-promoted-thread"),
    );
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("window-capture-draft-thread"),
    });
    store.markDraftThreadPromoting(draftId, promotedRef);

    expect(resolveExistingWindowCaptureTarget(draftId, null)).toEqual(promotedRef);
  });

  it("keeps the routed server thread before its shell loads", () => {
    const routeThreadRef = scopeThreadRef(
      environmentId,
      ThreadId.make("window-capture-routed-thread"),
    );

    expect(resolveExistingWindowCaptureTarget(routeThreadRef, routeThreadRef)).toEqual(
      routeThreadRef,
    );
  });
});
