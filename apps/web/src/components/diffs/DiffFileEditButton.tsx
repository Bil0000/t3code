import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useBlocker } from "@tanstack/react-router";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { PencilIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
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
import {
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  DialogCreateHandle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EditableFileSurface = lazy(() =>
  import("../files/FilePreviewPanel").then((module) => ({ default: module.EditableFileSurface })),
);
const noop = () => {};

interface DiffFileEditProps {
  environmentId: EnvironmentId;
  cwd: string;
  filePath: string;
  pullRequestUrl?: string;
  onSaved?: () => void;
}

function DiffFileEditor({
  environmentId,
  cwd,
  filePath,
  pullRequestUrl,
  onSaved,
  closeRequested,
  onClose,
  onKeepEditing,
}: DiffFileEditProps & {
  closeRequested: boolean;
  onClose: () => void;
  onKeepEditing: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [expectedBranch, setExpectedBranch] = useState<string | null>();
  if (expectedBranch === undefined && status.isSuccess)
    setExpectedBranch(status.data?.refName ?? null);
  const isMedia =
    isWorkspaceAudioPreviewPath(filePath) ||
    isWorkspaceImagePreviewPath(filePath) ||
    isWorkspaceVideoPreviewPath(filePath);
  const canEdit = status.isSuccess && (!pullRequestUrl || status.data?.pr?.url === pullRequestUrl);
  const [draft, setDraft] = useState<{ contents: string; savedContents: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = draft !== null && draft.contents !== draft.savedContents;
  const shouldBlock = useCallback(() => dirty || saving, [dirty, saving]);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: dirty || saving,
    withResolver: true,
  });
  const onContentsChange = useCallback((contents: string) => {
    setDraft((current) => current && { ...current, contents });
  }, []);

  useEffect(() => {
    if (!canEdit || isMedia || expectedBranch === undefined) return;
    const controller = new AbortController();
    void executeAtomQuery(appAtomRegistry, getProjectFileQueryAtom(environmentId, cwd, filePath), {
      refresh: true,
      signal: controller.signal,
      reportDefect: false,
      reportFailure: false,
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (result._tag === "Failure") {
        setReadError(formatEnvironmentQueryError(result.cause));
      } else if (result.value.truncated) {
        setReadError("This file is too large to edit here.");
      } else {
        const { contents } = result.value;
        setDraft((current) => current ?? { contents, savedContents: contents });
        setReadError(null);
      }
    });
    return () => controller.abort();
  }, [canEdit, cwd, environmentId, expectedBranch, filePath, isMedia]);

  const save = useCallback(async () => {
    if (!draft || !dirty || !canEdit || expectedBranch === undefined || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const result = await writeFile({
      environmentId,
      input: { cwd, relativePath: filePath, contents: draft.contents, expectedBranch },
    });
    if (result._tag === "Failure") {
      setSaveError(formatEnvironmentQueryError(result.cause));
    } else {
      setDraft((current) => current && { ...current, savedContents: draft.contents });
      appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, filePath));
      onSaved?.();
    }
    savingRef.current = false;
    setSaving(false);
  }, [canEdit, cwd, dirty, draft, environmentId, expectedBranch, filePath, onSaved, writeFile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [save]);

  useEffect(() => {
    if (dirty || saving) return;
    if (blocker.status === "blocked") {
      onClose();
      blocker.proceed();
    } else if (closeRequested) onClose();
  }, [blocker, closeRequested, dirty, onClose, saving]);

  const keepEditing = () => {
    onKeepEditing();
    if (blocker.status === "blocked") blocker.reset();
  };
  const discard = () => {
    onClose();
    if (blocker.status === "blocked") blocker.proceed();
  };
  const message = isMedia
    ? "This file cannot be edited as text."
    : !canEdit
      ? status.isPending
        ? "Checking the working copy..."
        : (status.error ??
          (pullRequestUrl
            ? "Check out this pull request to edit its files."
            : "Working copy is unavailable."))
      : readError;

  return (
    <>
      <div className="shrink-0 border-b border-border/60 px-4 py-3 pr-12">
        <DialogTitle className="flex items-start gap-2 text-sm">
          {dirty && (
            <span
              aria-label="Unsaved changes"
              className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
            />
          )}
          <span className="break-all">{filePath}</span>
        </DialogTitle>
        <DialogDescription className="mt-1 text-xs" aria-live="polite">
          {saveError ??
            message ??
            (saving
              ? "Saving..."
              : dirty
                ? "Unsaved changes · Cmd/Ctrl+S to save"
                : "Edit working copy · Cmd/Ctrl+S to save")}
        </DialogDescription>
      </div>
      {draft !== null ? (
        <Suspense fallback={<p className="p-4 text-sm">Loading editor...</p>}>
          <DiffWorkerPoolProvider>
            <EditableFileSurface
              environmentId={environmentId}
              cwd={cwd}
              relativePath={filePath}
              onContentsChange={onContentsChange}
              composerDraftTarget={null}
              contents={draft.contents}
              resolvedTheme={resolvedTheme}
              revealRequestId={0}
              wordWrap={wordWrap}
              onPostRender={noop}
              onPendingChange={noop}
            />
          </DiffWorkerPoolProvider>
        </Suspense>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">{message ?? "Loading file..."}</p>
      )}
      <div className="flex shrink-0 justify-end border-t border-border/60 px-4 py-3">
        <Button size="sm" disabled={!dirty || saving || !canEdit} onClick={() => void save()}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      <AlertDialog
        open={(closeRequested && (dirty || saving)) || blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) keepEditing();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes before leaving?</AlertDialogTitle>
            <AlertDialogDescription>
              {saving
                ? "Wait for the save to finish."
                : "Your edits will be lost if you leave without saving."}
              {saveError && (
                <span role="alert" className="mt-2 block text-destructive">
                  {saveError}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="ghost" disabled={saving} onClick={discard}>
              Discard
            </Button>
            <Button disabled={saving || !canEdit} onClick={() => void save()}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const reviewFileDialog = DialogCreateHandle<DiffFileEditProps>();

export function DiffFileEditButton(props: DiffFileEditProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-micro" variant="ghost" />}
        aria-label={`Edit ${props.filePath}`}
        onClick={() => reviewFileDialog.openWithPayload(props)}
      >
        <PencilIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>Edit working copy</TooltipPopup>
    </Tooltip>
  );
}

export function DiffFileEditDialog() {
  const [open, setOpen] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const onKeepEditing = useCallback(() => setCloseRequested(false), []);
  const onClose = useCallback(() => {
    setCloseRequested(false);
    setOpen(false);
  }, []);
  return (
    <Dialog
      handle={reviewFileDialog}
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else setCloseRequested(true);
      }}
    >
      {({ payload }) =>
        open && payload ? (
          <DialogPopup className="flex h-[min(44rem,85dvh)] w-[min(64rem,95vw)] max-w-none flex-col overflow-hidden">
            <DiffFileEditor
              {...payload}
              closeRequested={closeRequested}
              onClose={onClose}
              onKeepEditing={onKeepEditing}
            />
          </DialogPopup>
        ) : null
      }
    </Dialog>
  );
}
