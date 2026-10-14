import type { EnvironmentId, IssueListResult, ProjectId } from "@t3tools/contracts";

import { findScopedProject } from "../pullRequest/pullRequestList.logic";

interface ScopedProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

export type IssueListSources = NonNullable<IssueListResult["sources"]>;

export function issueListProjectScope<Project extends ScopedProject>(
  projects: ReadonlyArray<Project>,
  filter: {
    readonly projectId?: ProjectId | undefined;
    readonly environmentId?: EnvironmentId | undefined;
  },
  projectsKnown: boolean,
): Project | "waiting" | null {
  if (filter.projectId === undefined) return null;
  const project = findScopedProject(projects, filter.environmentId, filter.projectId);
  if (project !== undefined) return project;
  return projectsKnown ? null : "waiting";
}

export function issueFilterProjects<Project extends ScopedProject>(
  projects: ReadonlyArray<Project>,
  sources: ReadonlyMap<EnvironmentId, IssueListSources>,
  selected: ScopedProject | null,
): ReadonlyArray<
  Project & { readonly repositoryIdentity: { readonly canonicalKey: string } | null }
> {
  return projects.flatMap((project) => {
    const scopes = sources
      .get(project.environmentId)
      ?.filter((source) => source.projectId === project.id)
      .map((source) => `${source.tracker} ${source.host} ${source.scope}`.toLowerCase())
      .toSorted();
    const isSelected =
      project.id === selected?.id && project.environmentId === selected.environmentId;
    if (scopes?.length === 0 && !isSelected) return [];
    const repositoryIdentity = scopes ? { canonicalKey: JSON.stringify(scopes) } : null;
    return [{ ...project, repositoryIdentity }];
  });
}
