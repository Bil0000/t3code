import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { resolveScheduledTaskBaseRef } from "./ScheduledTasksSettings.logic";

export interface ScheduledTaskBackupBinding {
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly baseRef: string;
}

export function ScheduledTaskBackupFields({
  environmentId,
  binding,
  worktree,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly binding: ScheduledTaskBackupBinding;
  readonly worktree: boolean;
  readonly onChange: (binding: ScheduledTaskBackupBinding) => void;
}) {
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const project = projects.find((entry) => entry.id === binding.projectId);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const refsQuery = useEnvironmentQuery(
    worktree && project
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: project.workspaceRoot, limit: 2 },
        })
      : null,
  );
  const defaultBaseRef = resolveScheduledTaskBaseRef("", refsQuery.data?.refs ?? []);
  const firstEntry = entries[0];
  const firstModel = firstEntry?.models[0];
  useEffect(() => {
    const modelSelection =
      binding.modelSelection ??
      (firstEntry && firstModel
        ? createModelSelection(firstEntry.instanceId, firstModel.slug)
        : null);
    const baseRef = binding.baseRef || defaultBaseRef;
    if (modelSelection !== binding.modelSelection || baseRef !== binding.baseRef) {
      onChange({ ...binding, modelSelection, baseRef });
    }
  }, [binding, defaultBaseRef, firstEntry, firstModel, onChange]);
  const selection = binding.modelSelection;
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="text-xs font-medium">Backup project</span>
        <Select
          value={binding.projectId}
          onValueChange={(projectId) => onChange({ ...binding, projectId, baseRef: "" })}
        >
          <SelectTrigger size="sm" aria-label="Backup project">
            <SelectValue placeholder="Select the project on the backup server">
              {project?.title}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {worktree ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="scheduled-task-backup-base-ref">
            Backup base ref
          </label>
          <Input
            id="scheduled-task-backup-base-ref"
            value={binding.baseRef}
            placeholder={refsQuery.isPending ? "Loading default branch…" : "Branch or commit"}
            onChange={(event) => onChange({ ...binding, baseRef: event.target.value })}
          />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <span className="text-xs font-medium">Backup model</span>
        {selection ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                selection.instanceId,
                selection.model,
              )}
              triggerVariant="outline"
              onInstanceModelChange={(instanceId, model) =>
                onChange({ ...binding, modelSelection: createModelSelection(instanceId, model) })
              }
            />
            {entry ? (
              <TraitsPicker
                provider={entry.driverKind}
                models={entry.models}
                model={selection.model}
                prompt=""
                onPromptChange={() => undefined}
                modelOptions={selection.options}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled}
                triggerVariant="outline"
                onModelOptionsChange={(options) =>
                  onChange({
                    ...binding,
                    modelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" role="status">
            Connect the backup server and enable a provider to select its model.
          </p>
        )}
      </div>
    </div>
  );
}
