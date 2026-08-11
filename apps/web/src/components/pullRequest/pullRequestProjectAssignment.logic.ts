import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/** The little of a project this needs: who holds it, and which repository it is a copy of. */
export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
}

/**
 * Two servers can hold the same repository, and both would list the same pull requests. The
 * remote's normalized URL (`canonicalKey`) is what says "same repository" across machines — it
 * comes from the remote, not from a local path — so it is what one copy is picked by.
 *
 * A project with no identity is never de-duplicated: nothing proves it is a copy of anything, and
 * dropping it would lose its rows outright.
 */
export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  // Which server lists each repository: the preferred one where it has it, else the first.
  const owner = new Map<string, EnvironmentId>();
  for (const project of projects) {
    const key = project.repositoryIdentity?.canonicalKey?.toLowerCase();
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (current === undefined) {
      owner.set(key, project.environmentId);
      continue;
    }
    if (current === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project.environmentId);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = project.repositoryIdentity?.canonicalKey?.toLowerCase();
    if (key && owner.get(key) !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
}
