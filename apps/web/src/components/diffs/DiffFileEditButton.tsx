import type { EnvironmentId } from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { PencilIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EditableFileSurface = lazy(() =>
  import("../files/FilePreviewPanel").then((module) => ({ default: module.EditableFileSurface })),
);
const onPostRender = () => {};

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
}: DiffFileEditProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const [expectedBranch, setExpectedBranch] = useState<string | null>();
  if (expectedBranch === undefined && status.isSuccess)
    setExpectedBranch(status.data?.refName ?? null);
  const isMedia = isWorkspaceImagePreviewPath(filePath) || isWorkspaceVideoPreviewPath(filePath);
  const canEdit = status.isSuccess && (!pullRequestUrl || status.data?.pr?.url === pullRequestUrl);
  const file = useProjectFileQuery(environmentId, cwd, filePath, canEdit);
  const refreshFile = file.refresh;
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onPendingChange = useCallback(
    (_path: string, value: boolean) => {
      setPending(value);
      if (!value) onSaved?.();
    },
    [onSaved],
  );
  useEffect(() => {
    if (canEdit) refreshFile();
  }, [canEdit, refreshFile]);

  const message = isMedia
    ? "This file cannot be edited as text."
    : !canEdit
      ? status.isPending
        ? "Checking the working copy..."
        : (status.error ??
          (pullRequestUrl
            ? "Check out this pull request to edit its files."
            : "Working copy is unavailable."))
      : file.error
        ? file.error
        : file.data?.truncated
          ? "This file is too large to edit here."
          : file.data === null
            ? "Loading file..."
            : null;

  return (
    <>
      <div className="shrink-0 border-b border-border/60 px-4 py-3 pr-12">
        <DialogTitle className="break-all text-sm">{filePath}</DialogTitle>
        <DialogDescription className="mt-1 text-xs" aria-live="polite">
          {saveError ?? (pending ? "Saving..." : "Edit working copy · Changes save automatically")}
        </DialogDescription>
      </div>
      {message !== null ? (
        <p className="p-4 text-sm text-muted-foreground">{message}</p>
      ) : file.data !== null ? (
        <Suspense fallback={<p className="p-4 text-sm">Loading editor...</p>}>
          <DiffWorkerPoolProvider>
            <EditableFileSurface
              environmentId={environmentId}
              cwd={cwd}
              relativePath={filePath}
              expectedBranch={expectedBranch ?? null}
              onSaveError={setSaveError}
              composerDraftTarget={null}
              contents={file.data.contents}
              resolvedTheme={resolvedTheme}
              revealRequestId={0}
              wordWrap={wordWrap}
              onPostRender={onPostRender}
              onPendingChange={onPendingChange}
            />
          </DiffWorkerPoolProvider>
        </Suspense>
      ) : null}
    </>
  );
}

export function DiffFileEditButton(props: DiffFileEditProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button size="icon-micro" variant="ghost" />}
              aria-label={`Edit ${props.filePath}`}
            />
          }
        >
          <PencilIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Edit working copy</TooltipPopup>
      </Tooltip>
      {open ? (
        <DialogPopup className="flex h-[min(44rem,85dvh)] w-[min(64rem,95vw)] max-w-none flex-col overflow-hidden">
          <DiffFileEditor {...props} />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
