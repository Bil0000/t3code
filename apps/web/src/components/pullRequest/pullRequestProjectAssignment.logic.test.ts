import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignProjectsToEnvironments,
  type AssignableProject,
} from "./pullRequestProjectAssignment.logic";

const project = (id: string, environmentId: string, canonicalKey?: string): AssignableProject => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  repositoryIdentity: canonicalKey === undefined ? null : { canonicalKey },
});

const envs = (...ids: ReadonlyArray<string>) => ids as ReadonlyArray<EnvironmentId>;

const plain = (assignment: Map<EnvironmentId, ProjectId[]>) =>
  Object.fromEntries([...assignment].map(([id, projectIds]) => [id, projectIds]));

describe("one server per repository", () => {
  it("lets the first server list a repository both hold", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("b1", "env-1", "github.com/acme/tools"),
        project("a2", "env-2", "github.com/acme/app"),
        project("c2", "env-2", "github.com/acme/site"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "b1"], "env-2": ["c2"] });
  });

  it("prefers the named server over the first one", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-2": ["a2"] });
  });

  it("drops a server with nothing of its own", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(assignment.has("env-2" as EnvironmentId)).toBe(false);
  });

  it("keeps every copy of a project that has no identity to compare", () => {
    const assignment = assignProjectsToEnvironments(
      [project("p1", "env-1"), project("p2", "env-2")],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["p1"], "env-2": ["p2"] });
  });

  it("keeps a repository listed by the one server that holds it", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("b2", "env-2", "gitlab.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1"], "env-2": ["b2"] });
  });

  it("keeps a server's own worktrees of the repository it lists", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "GitHub.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "a1-wt"] });
  });

  it("treats differently-cased repository paths on the same host as distinct repositories", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "git.example.com/Team/App"),
        project("b1", "env-1", "git.example.com/team/app"),
        project("a2", "env-2", "GIT.example.com/Team/App"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    // Host casing still collapses (env-1's "Team/App" wins over env-2's), but the
    // differently-cased path "team/app" is a separate repository, not a duplicate.
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "b1"] });
  });

  it("ignores a project on a server that is not being read", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-2": ["a2"] });
  });

  it("answers the same whatever order the projects arrive in", () => {
    const projects = [
      project("a2", "env-2", "github.com/acme/app"),
      project("a1", "env-1", "github.com/acme/app"),
    ];
    const forward = assignProjectsToEnvironments(projects, envs("env-1", "env-2"), null);
    const backward = assignProjectsToEnvironments(
      projects.toReversed(),
      envs("env-1", "env-2"),
      null,
    );
    expect(plain(forward)).toEqual({ "env-1": ["a1"] });
    expect(plain(backward)).toEqual(plain(forward));
  });
});
