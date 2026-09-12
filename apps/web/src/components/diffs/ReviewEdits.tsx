import { useBlocker } from "@tanstack/react-router";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { getProjectFileQueryAtom } from "../files/projectFilesQueryState";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export interface ReviewEditTarget {
  environmentId: EnvironmentId;
  cwd: string;
  filePath: string;
  pullRequestUrl?: string;
  onSaved?: () => void;
}

interface ReviewDraft extends ReviewEditTarget {
  contents: string;
  savedContents: string;
  expectedBranch: string | null;
}

export function reviewEditKey(target: ReviewEditTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.filePath]);
}

export async function readReviewDraft(target: ReviewEditTarget): Promise<ReviewDraft> {
  let status = await Effect.runPromise(
    AtomRegistry.getResult(
      appAtomRegistry,
      vcsEnvironment.status({
        environmentId: target.environmentId,
        input: { cwd: target.cwd },
      }),
    ),
  );
  if (target.pullRequestUrl) {
    const refreshed = await vcsEnvironment.refreshStatus.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
    if (refreshed._tag === "Failure") throw new Error(formatEnvironmentQueryError(refreshed.cause));
    status = refreshed.value;
  }
  if (target.pullRequestUrl && status.pr?.url !== target.pullRequestUrl) {
    throw new Error("Check out this pull request to edit its files.");
  }
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(target.environmentId, target.cwd, target.filePath),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
  if (result.value.truncated) throw new Error("This file is too large to edit here.");
  return {
    ...target,
    contents: result.value.contents,
    savedContents: result.value.contents,
    expectedBranch: status.refName,
  };
}

const ReviewEditsContext = createContext<{
  drafts: ReadonlyMap<string, ReviewDraft>;
  begin: (draft: ReviewDraft) => void;
  change: (key: string, contents: string) => void;
  focus: (key: string | null) => void;
} | null>(null);

export const useReviewEdits = () => useContext(ReviewEditsContext);

export function ReviewEditsProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ReviewDraft>>(new Map());
  const draftsRef = useRef(drafts);
  const focusedKey = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const dirty = [...drafts.values()].some((draft) => draft.contents !== draft.savedContents);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || saving,
    enableBeforeUnload: dirty || saving,
    withResolver: true,
  });
  const update = useCallback((next: ReadonlyMap<string, ReviewDraft>) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const focus = useCallback((key: string | null) => {
    focusedKey.current = key;
  }, []);
  const begin = useCallback(
    (draft: ReviewDraft) => {
      const key = reviewEditKey(draft);
      const current = draftsRef.current.get(key);
      if (current && current.contents !== current.savedContents) return;
      update(new Map(draftsRef.current).set(key, draft));
    },
    [update],
  );
  const change = useCallback(
    (key: string, contents: string) => {
      const current = draftsRef.current.get(key);
      if (current) update(new Map(draftsRef.current).set(key, { ...current, contents }));
    },
    [update],
  );
  const save = useCallback(
    async (keys: readonly string[]) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        for (const key of keys) {
          const draft = draftsRef.current.get(key);
          if (!draft || draft.contents === draft.savedContents) continue;
          const result = await writeFile({
            environmentId: draft.environmentId,
            input: {
              cwd: draft.cwd,
              relativePath: draft.filePath,
              contents: draft.contents,
              expectedBranch: draft.expectedBranch,
            },
          });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
          const current = draftsRef.current.get(key);
          if (current)
            update(
              new Map(draftsRef.current).set(key, { ...current, savedContents: draft.contents }),
            );
          appAtomRegistry.refresh(
            getProjectFileQueryAtom(draft.environmentId, draft.cwd, draft.filePath),
          );
          draft.onSaved?.();
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The file could not be saved.";
        setError(message);
        toastManager.add({ type: "error", title: "Changes were not saved", description: message });
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [update, writeFile],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "s" ||
        focusedKey.current === null
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void save([focusedKey.current]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [save]);
  useEffect(() => {
    if (blocker.status !== "blocked" || dirty || saving) return;
    update(new Map());
    focusedKey.current = null;
    blocker.proceed();
  }, [blocker, dirty, saving, update]);

  return (
    <ReviewEditsContext value={{ drafts, begin, change, focus }}>
      {children}
      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes before leaving?</AlertDialogTitle>
            <AlertDialogDescription>
              {saving
                ? "Wait for the save to finish."
                : "Your review edits will be lost if you leave without saving."}
              {error && (
                <span role="alert" className="mt-2 block text-destructive">
                  {error}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (blocker.status === "blocked") blocker.reset();
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                update(new Map());
                focusedKey.current = null;
                if (blocker.status === "blocked") blocker.proceed();
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} onClick={() => void save([...draftsRef.current.keys()])}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ReviewEditsContext>
  );
}
