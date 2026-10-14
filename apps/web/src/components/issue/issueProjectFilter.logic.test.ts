import { EnvironmentId, IssueCapabilities, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestFilterProjects } from "../pullRequest/pullRequestProjectFilter.logic";
import {
  issueFilterProjects,
  issueListProjectScope,
  type IssueListSources,
} from "./issueProjectFilter.logic";

const cups = EnvironmentId.make("env-cups");
const nucbox = EnvironmentId.make("env-nucbox");
const project = (id: string, environmentId = nucbox) => ({
  id: ProjectId.make(id),
  environmentId,
  title: "t3code",
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: { canonicalKey: "github.com/pingdotgg/t3code" },
});
const source = (projectId: string, tracker: string, scope: string) =>
  ({
    projectId: ProjectId.make(projectId),
    projectTitle: "t3code",
    tracker: IssueTrackerKind.make(tracker),
    host: tracker === "github" ? "github.com" : "acme.atlassian.net",
    scope,
    capabilities: {} as IssueCapabilities,
  }) satisfies IssueListSources[number];

describe("issueListProjectScope", () => {
  const projects = [project("main"), project("main", cups), project("solo", cups)];

  it("pairs a shared project id with the server the filter names", () => {
    expect(
      issueListProjectScope(
        projects,
        { projectId: ProjectId.make("main"), environmentId: cups },
        true,
      ),
    ).toBe(projects[1]);
  });

  it("waits for the servers before reading, then drops a vanished or ambiguous project", () => {
    const gone = { projectId: ProjectId.make("gone"), environmentId: cups };
    expect(issueListProjectScope(projects, gone, false)).toBe("waiting");
    expect(issueListProjectScope(projects, gone, true)).toBeNull();
    expect(issueListProjectScope(projects, { projectId: ProjectId.make("main") }, true)).toBeNull();
    expect(issueListProjectScope(projects, { projectId: ProjectId.make("solo") }, true)).toBe(
      projects[2],
    );
  });
});

describe("issueFilterProjects", () => {
  it("offers one choice per distinct tracker scope set and hides projects without a tracker", () => {
    const projects = [
      project("main"),
      project("checkout"),
      project("jira-bound"),
      project("plain"),
      project("main", cups),
    ];
    const sources = new Map([
      [
        nucbox,
        [
          source("main", "github", "pingdotgg/t3code"),
          source("checkout", "github", "pingdotgg/t3code"),
          source("jira-bound", "github", "pingdotgg/t3code"),
          source("jira-bound", "jira", "T3"),
        ],
      ],
    ]);

    const choices = pullRequestFilterProjects(
      issueFilterProjects(projects, sources, null),
      new Map(),
    );

    expect(choices.map(({ id, environmentId }) => [environmentId, id])).toEqual(
      expect.arrayContaining([
        [nucbox, "main"],
        [nucbox, "jira-bound"],
        [cups, "main"],
      ]),
    );
    expect(choices).toHaveLength(3);
  });

  it("keeps the selected project even when its tracker went away", () => {
    const selected = project("plain");
    const choices = issueFilterProjects([selected], new Map([[nucbox, []]]), selected);
    expect(choices.map(({ id }) => id)).toEqual(["plain"]);
  });
});
