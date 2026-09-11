import { ProjectWriteFileError, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { createRef, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;
const isProjectWriteFileError = Schema.is(ProjectWriteFileError);

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  expectedBranch?: string | null;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveError?: (message: string | null) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  expectedBranch,
  onPendingChange,
  onSaveError,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: async (nextContents) => {
            const draft = getOptimisticProjectFileQueryData(
              environmentId,
              cwd,
              relativePath,
              expectedBranch,
            );
            const result = await writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(expectedBranch !== undefined ? { expectedBranch } : {}),
              },
            });
            const error = result._tag === "Failure" ? Cause.squash(result.cause) : null;
            if (
              isProjectWriteFileError(error) &&
              error.failure === "checkout_changed" &&
              expectedBranch !== undefined &&
              draft?.contents === nextContents &&
              getOptimisticProjectFileQueryData(
                environmentId,
                cwd,
                relativePath,
                expectedBranch,
              ) === draft
            ) {
              clearProjectFileQueryData(environmentId, cwd, relativePath, expectedBranch);
            }
            onSaveError?.(
              result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            );
            return result;
          },
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(
              environmentId,
              cwd,
              relativePath,
              confirmedContents,
              expectedBranch,
            );
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, expectedBranch, onPendingChange, onSaveError, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
