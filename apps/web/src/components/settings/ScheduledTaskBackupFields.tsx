import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useProjects } from "../../state/entities";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ScheduledTaskBackupFields({
  environmentId,
  projectId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly onChange: (projectId: ProjectId | null) => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const selected = projects.find((project) => project.id === projectId);
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">Backup project</span>
      <Select value={projectId} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-label="Backup project">
          <SelectValue placeholder="Choose the same project on the backup host">
            {selected?.title}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="min-w-0">
                <span className="block truncate">{project.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {selected ? (
        <p className="break-all text-xs text-muted-foreground">{selected.workspaceRoot}</p>
      ) : null}
    </div>
  );
}
