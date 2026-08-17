import type { SelectedWorkItem } from "~/workItemSelection";
import { describe, expect, it } from "vite-plus/test";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

const item: SelectedWorkItem = {
  kind: "issue",
  environmentId: "environment-1" as SelectedWorkItem["environmentId"],
  projectId: "project-1" as SelectedWorkItem["projectId"],
  repository: "acme/app",
  number: 12,
  title: "Fix session refresh",
  url: "https://github.com/acme/app/issues/12",
};

type SelectionBarModule = {
  readonly WORK_ITEM_MODE_HELP: Record<"compound" | "subtasks", string>;
  readonly workItemGeneratingDraft: (
    mode: "compound" | "subtasks",
    items: ReadonlyArray<SelectedWorkItem>,
  ) => string;
  readonly createGeneratedWorkItemDraft: (input: {
    readonly mode: "compound" | "subtasks";
    readonly items: ReadonlyArray<SelectedWorkItem>;
    readonly openThread: () => Promise<{ readonly draftId: string } | null>;
    readonly generate: () => Promise<
      | { readonly _tag: "Failure" }
      | {
          readonly _tag: "Success";
          readonly value: { readonly prompt: string; readonly generated: boolean };
        }
    >;
    readonly getPrompt: (draftId: string) => string | undefined;
    readonly setPrompt: (draftId: string, prompt: string) => void;
    readonly clear: () => void;
  }) => Promise<{ readonly status: "success" | "generation-failure" | "thread-failure" }>;
};

async function selectionBar(): Promise<SelectionBarModule> {
  return (await import("./WorkItemSelectionBar")) as unknown as SelectionBarModule;
}

describe("work item task draft", () => {
  it("shows the exact help for each task shape", async () => {
    const { WORK_ITEM_MODE_HELP } = await selectionBar();

    expect(WORK_ITEM_MODE_HELP).toEqual({
      compound: "One task that merges overlap and orders dependencies.",
      subtasks: "One parent task split into ordered child steps.",
    });
  });

  it("opens a marked draft before AI generation resolves", async () => {
    const { createGeneratedWorkItemDraft, workItemGeneratingDraft } = await selectionBar();
    const generation = deferred<
      | { readonly _tag: "Failure" }
      | {
          readonly _tag: "Success";
          readonly value: { readonly prompt: string; readonly generated: boolean };
        }
    >();
    let prompt: string | undefined;
    let opened = false;

    const creating = createGeneratedWorkItemDraft({
      mode: "compound",
      items: [item],
      openThread: async () => {
        opened = true;
        return { draftId: "draft-1" };
      },
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      clear: () => undefined,
    });

    await Promise.resolve();
    expect(opened).toBe(true);
    expect(prompt).toBe(workItemGeneratingDraft("compound", [item]));

    generation.resolve({ _tag: "Success", value: { prompt: "AI task", generated: true } });
    await expect(creating).resolves.toEqual({ status: "success" });
  });

  it("does not replace a marked draft after the user edits it", async () => {
    const { createGeneratedWorkItemDraft } = await selectionBar();
    const generation = deferred<
      | { readonly _tag: "Failure" }
      | {
          readonly _tag: "Success";
          readonly value: { readonly prompt: string; readonly generated: boolean };
        }
    >();
    let prompt: string | undefined;

    const creating = createGeneratedWorkItemDraft({
      mode: "subtasks",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      clear: () => undefined,
    });

    await Promise.resolve();
    prompt = "My edited task";
    generation.resolve({ _tag: "Success", value: { prompt: "AI task", generated: true } });
    await creating;

    expect(prompt).toBe("My edited task");
  });
});
