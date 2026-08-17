import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ListChecksIcon, LoaderIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useAtomCommand } from "~/state/use-atom-command";
import { generateWorkItemTask } from "~/state/workItems";
import { useWorkItemSelection } from "~/workItemSelection";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function WorkItemSelectButton() {
  const selecting = useWorkItemSelection((state) => state.selecting);
  const count = useWorkItemSelection((state) => state.items.length);
  const start = useWorkItemSelection((state) => state.start);
  const clear = useWorkItemSelection((state) => state.clear);
  return (
    <Button size="xs" variant="outline" onClick={selecting ? clear : start}>
      {selecting ? (
        <XIcon aria-hidden className="size-3.5" />
      ) : (
        <ListChecksIcon aria-hidden className="size-3.5" />
      )}
      {selecting ? `Cancel${count > 0 ? ` (${count})` : ""}` : "Select"}
    </Button>
  );
}

export function WorkItemSelectionBar() {
  const selecting = useWorkItemSelection((state) => state.selecting);
  const items = useWorkItemSelection((state) => state.items);
  const mode = useWorkItemSelection((state) => state.mode);
  const setMode = useWorkItemSelection((state) => state.setMode);
  const clear = useWorkItemSelection((state) => state.clear);
  const generate = useAtomCommand(generateWorkItemTask, { reportFailure: false });
  const newThread = useNewThreadHandler();
  const [busy, setBusy] = useState(false);

  if (!selecting) return null;

  const createTask = async () => {
    const first = items[0];
    if (!first || busy) return;
    setBusy(true);
    const generation = await generate({
      environmentId: first.environmentId,
      input: {
        projectId: first.projectId,
        mode,
        items: items.map(({ kind, repository, number }) => ({ kind, repository, number })),
      },
    });
    if (generation._tag === "Failure") {
      setBusy(false);
      toastManager.add({
        type: "error",
        title: "Could not create task",
        description: "Refresh the selected items and try again.",
      });
      return;
    }
    const opened = await newThread(scopeProjectRef(first.environmentId, first.projectId));
    setBusy(false);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not open a thread" });
      return;
    }
    useComposerDraftStore.getState().setPrompt(opened.draftId, generation.value.prompt);
    clear();
    toastManager.add({
      type: "success",
      title: generation.value.generated ? "Task drafted with AI" : "Task drafted",
      description: "Review the task in the composer, then send it.",
    });
  };

  return (
    <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur">
      <span className="mr-auto text-xs text-muted-foreground">
        {items.length === 0 ? "Select issues or pull requests" : `${items.length} selected`}
      </span>
      <div className="flex rounded-md bg-muted p-0.5">
        <Button
          size="xs"
          variant={mode === "compound" ? "secondary" : "ghost"}
          onClick={() => setMode("compound")}
        >
          Compound
        </Button>
        <Button
          size="xs"
          variant={mode === "subtasks" ? "secondary" : "ghost"}
          onClick={() => setMode("subtasks")}
        >
          Subtasks
        </Button>
      </div>
      <Button size="xs" disabled={items.length === 0 || busy} onClick={() => void createTask()}>
        {busy ? (
          <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <SparklesIcon aria-hidden className="size-3.5" />
        )}
        Create task
      </Button>
    </div>
  );
}
