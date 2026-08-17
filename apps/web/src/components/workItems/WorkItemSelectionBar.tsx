import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ListChecksIcon, LoaderIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useAtomCommand } from "~/state/use-atom-command";
import { generateWorkItemTask } from "~/state/workItems";
import { type SelectedWorkItem, useWorkItemSelection } from "~/workItemSelection";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export const WORK_ITEM_MODE_HELP = {
  compound: "One task that merges overlap and orders dependencies.",
  subtasks: "One parent task split into ordered child steps.",
} as const;

export function workItemGeneratingDraft(
  mode: "compound" | "subtasks",
  items: ReadonlyArray<SelectedWorkItem>,
) {
  return [
    "Generating a task from the selected sources…",
    "",
    mode === "compound" ? "Compound task sources:" : "Parent task sources:",
    ...items.map((item) => `- [${item.title}](${item.url}) (${item.repository}#${item.number})`),
  ].join("\n");
}

type WorkItemTaskGeneration =
  | { readonly _tag: "Failure" }
  | {
      readonly _tag: "Success";
      readonly value: { readonly prompt: string; readonly generated: boolean };
    };

export async function createGeneratedWorkItemDraft<TDraftId>(input: {
  readonly mode: "compound" | "subtasks";
  readonly items: ReadonlyArray<SelectedWorkItem>;
  readonly openThread: () => Promise<{ readonly draftId: TDraftId } | null>;
  readonly generate: () => Promise<WorkItemTaskGeneration>;
  readonly getPrompt: (draftId: TDraftId) => string | undefined;
  readonly setPrompt: (draftId: TDraftId, prompt: string) => void;
  readonly clear: () => void;
}): Promise<{ readonly status: "success" | "generation-failure" | "thread-failure" }> {
  const opened = await input.openThread();
  if (opened === null) return { status: "thread-failure" };

  const draft = workItemGeneratingDraft(input.mode, input.items);
  input.setPrompt(opened.draftId, draft);
  const generation = await input.generate();
  if (generation._tag === "Failure") return { status: "generation-failure" };

  if (input.getPrompt(opened.draftId) === draft)
    input.setPrompt(opened.draftId, generation.value.prompt);
  input.clear();
  return { status: "success" };
}

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
    const result = await createGeneratedWorkItemDraft({
      mode,
      items,
      openThread: () => newThread(scopeProjectRef(first.environmentId, first.projectId)),
      generate: () =>
        generate({
          environmentId: first.environmentId,
          input: {
            projectId: first.projectId,
            mode,
            items: items.map(({ kind, repository, number }) => ({ kind, repository, number })),
          },
        }),
      getPrompt: (draftId) => useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt,
      setPrompt: (draftId, prompt) => useComposerDraftStore.getState().setPrompt(draftId, prompt),
      clear,
    });
    setBusy(false);
    if (result.status === "thread-failure") {
      toastManager.add({ type: "error", title: "Could not open a thread" });
      return;
    }
    if (result.status === "generation-failure") {
      toastManager.add({
        type: "error",
        title: "Could not generate a task",
        description: "The source links are in the draft. You can edit it or try again.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Task drafted",
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
      <span className="text-xs text-muted-foreground">{WORK_ITEM_MODE_HELP[mode]}</span>
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
