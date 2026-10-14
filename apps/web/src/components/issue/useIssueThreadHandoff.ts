import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type IssueDetail,
  type IssueRef,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";

import { toastManager } from "../ui/toast";

function issueHandoffPrompt(detail: Pick<IssueDetail, "displayKey" | "title" | "url">) {
  return `Work on issue ${detail.displayKey}: ${detail.title}\n${detail.url}`;
}

export async function withIssueThreadHandoff<A, E>(
  start: Promise<AtomCommandResult<A, E>>,
  draftTarget: ComposerThreadTarget,
  threadRef: ScopedThreadRef,
  projectId: ProjectId,
  url: string | undefined,
): Promise<AtomCommandResult<A, E>> {
  const result = await start;
  if (result._tag === "Success" && url) {
    await completeIssueThreadHandoff(draftTarget, threadRef, projectId, url);
  }
  return result;
}

async function completeIssueThreadHandoff(
  draftTarget: ComposerThreadTarget,
  threadRef: ScopedThreadRef,
  projectId: ProjectId,
  url: string,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(threadRef)?.pendingIssueUrl === undefined) {
    store.setPendingIssueUrl(threadRef, url);
  }
  try {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot change threads or projects.");
    }
    const resolved = await runAtomCommand(
      appAtomRegistry,
      issueEnvironment.resolveUrl,
      { environmentId: threadRef.environmentId, input: { projectId, url } },
      { reportFailure: false },
    );
    if (resolved._tag === "Failure") {
      throw new Error(formatEnvironmentQueryError(resolved.cause));
    }
    if (resolved.value.projectId !== projectId) {
      throw new Error(
        "Configure this issue tracker in the thread's destination project, then retry.",
      );
    }
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot change threads or projects.");
    }
    const { writable: _writable, ...reference } = resolved.value;
    const linked = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.linkIssue,
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, ...reference, url, source: "manual" },
      },
      { reportFailure: false },
    );
    if (linked._tag === "Failure") {
      throw new Error(formatEnvironmentQueryError(linked.cause));
    }
    for (const target of [draftTarget, threadRef]) {
      const session = store.getDraftThread(target);
      if (
        typeof target === "string" &&
        (!session ||
          session.threadId !== threadRef.threadId ||
          session.environmentId !== threadRef.environmentId ||
          session.projectId !== projectId)
      )
        continue;
      if (store.getComposerDraft(target)?.pendingIssueUrl === url) {
        store.setPendingIssueUrl(target, undefined);
      }
    }
  } catch (error) {
    const toastId = toastManager.add({
      type: "error",
      title: "Could not link the thread to this issue",
      description: error instanceof Error ? error.message : "Retry linking this issue.",
      timeout: 0,
      actionProps: {
        children: "Retry",
        onClick: async () => {
          toastManager.close(toastId);
          if (
            useComposerDraftStore.getState().getComposerDraft(threadRef)?.pendingIssueUrl !== url
          ) {
            return;
          }
          await completeIssueThreadHandoff(draftTarget, threadRef, projectId, url);
        },
      },
    });
  }
}

export function useIssueThreadHandoff(environmentId: EnvironmentId, reference: IssueRef) {
  const newThread = useNewThreadHandler();
  const starting = useRef(false);
  const [pending, setPending] = useState(false);

  const start = async (detail: IssueDetail) => {
    if (starting.current) return;
    starting.current = true;
    setPending(true);
    const opened = await newThread(scopeProjectRef(environmentId, reference.projectId)).catch(
      () => null,
    );
    starting.current = false;
    setPending(false);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not start a thread for this issue" });
      return;
    }
    const store = useComposerDraftStore.getState();
    if ((store.getComposerDraft(opened.draftId)?.prompt ?? "").trim().length === 0) {
      store.setPrompt(opened.draftId, issueHandoffPrompt(detail));
    }
    store.setPendingIssueUrl(opened.draftId, detail.url);
  };

  return { pending, start };
}
