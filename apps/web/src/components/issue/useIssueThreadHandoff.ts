import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueDetail, IssueRef } from "@t3tools/contracts";
import { useContext, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { waitForThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";

import { toastManager } from "../ui/toast";

export function issueHandoffPrompt(detail: Pick<IssueDetail, "displayKey" | "title" | "url">) {
  return `Work on issue ${detail.displayKey}: ${detail.title}\n${detail.url}`;
}

const THREAD_LINK_WAIT_MS = 10 * 60_000;

export function useIssueThreadHandoff(environmentId: EnvironmentId, reference: IssueRef) {
  const registry = useContext(RegistryContext);
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);

  const start = async (detail: IssueDetail) => {
    if (pending) return;
    setPending(true);
    const opened = await newThread(scopeProjectRef(environmentId, reference.projectId)).catch(
      () => null,
    );
    setPending(false);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not start a thread for this issue" });
      return;
    }
    const store = useComposerDraftStore.getState();
    if ((store.getComposerDraft(opened.draftId)?.prompt ?? "").trim().length === 0) {
      store.setPrompt(opened.draftId, issueHandoffPrompt(detail));
    }
    const threadRef = scopeThreadRef(environmentId, opened.threadId);
    if (!(await waitForThreadShell(threadRef, THREAD_LINK_WAIT_MS))) {
      toastManager.add({
        type: "error",
        title: "Could not link the thread to this issue",
        description: "The thread did not start in time.",
      });
      return;
    }
    const result = await runAtomCommand(
      registry,
      threadEnvironment.linkIssue,
      {
        environmentId,
        input: {
          threadId: opened.threadId,
          ...reference,
          host: reference.host ?? detail.host,
          url: detail.url,
          source: "manual",
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not link the thread to this issue" });
    }
  };

  return { pending, start };
}
