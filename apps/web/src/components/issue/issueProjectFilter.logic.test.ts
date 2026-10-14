import { EnvironmentId, IssueCapabilities, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { continueIssueListPage } from "@t3tools/client-runtime/state/issues";

import { pullRequestFilterProjects } from "../pullRequest/pullRequestProjectFilter.logic";
import {
  issueCreateSources,
  issueFilterProjects,
  issueListProjectScope,
  issueListRefreshSource,
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

describe("issueCreateSources", () => {
  it("offers the rebound continuation source while keeping the original tracker status", () => {
    const old = {
      ...source("old", "github", "acme/web"),
      projectTitle: "Old checkout",
      capabilities: { create: true } as IssueCapabilities,
    };
    const current = {
      ...old,
      projectId: ProjectId.make("current"),
      projectTitle: "Current checkout",
    };
    const cursor = { "github github.com acme/web": "2" };
    const answer = {
      sources: [old],
      trackers: [
        {
          tracker: old.tracker,
          host: old.host,
          configured: true,
          projectCount: 1,
          capabilities: old.capabilities,
          detail: null,
        },
      ],
      entries: [],
      errors: [],
      nextCursors: cursor,
      viewers: {},
    };
    const held = { ...answer, answer, firstCursors: cursor, firstKeys: new Set<string>() };
    const continued = continueIssueListPage(
      held,
      cursor,
      {
        entries: [],
        sources: [current],
        nextCursors: { "github github.com acme/web": "3" },
        errors: [],
      },
      held.firstCursors,
    );
    expect(continued.answer).toBe(answer);
    expect(issueCreateSources(continued.answer, continued.sources)).toEqual([current]);
    expect(
      issueCreateSources(
        { ...answer, trackers: [{ ...answer.trackers[0]!, configured: false }] },
        continued.sources,
      ),
    ).toEqual([]);
    expect(issueCreateSources(answer, [])).toEqual([]);
  });

  it("keeps the configured tracker when another tracker on the same host cannot be used", () => {
    const github = {
      ...source("main", "github", "acme/web"),
      host: "shared.example",
      capabilities: { create: true } as IssueCapabilities,
    };
    const gitlab = { ...github, tracker: IssueTrackerKind.make("gitlab") };
    const answer = {
      sources: [github, gitlab],
      trackers: [
        {
          tracker: github.tracker,
          host: github.host,
          configured: false,
          projectCount: 1,
          capabilities: null,
          detail: "unavailable",
        },
        {
          tracker: gitlab.tracker,
          host: "SHARED.EXAMPLE",
          configured: true,
          projectCount: 1,
          capabilities: gitlab.capabilities,
          detail: null,
        },
      ],
    };
    expect(issueCreateSources(answer, answer.sources)).toEqual([gitlab]);
    expect(
      issueCreateSources({ ...answer, trackers: answer.trackers.toReversed() }, answer.sources),
    ).toEqual([gitlab]);
  });
});
describe("issueListRefreshSource", () => {
  const main = source("main", "github", "pingdotgg/t3code");
  const alias = source("checkout", "github", "pingdotgg/t3code");
  const held = { entries: [], sources: [main] };

  it("skips source writes outside the selected environment, project, or tracker host", () => {
    const input = { state: "open" as const, projectId: main.projectId, host: main.host };
    expect(issueListRefreshSource(cups, [nucbox], input, main, held)).toBeNull();
    expect(
      issueListRefreshSource(nucbox, [nucbox], input, source("other", "github", "org/other"), held),
    ).toBeNull();
    expect(
      issueListRefreshSource(nucbox, [nucbox], input, source("other", "jira", "T3"), held),
    ).toBeNull();
    expect(
      issueListRefreshSource(
        nucbox,
        [nucbox],
        { state: "all", host: "acme.atlassian.net" },
        main,
        held,
      ),
    ).toBeNull();
  });

  it("refreshes a worktree alias through the held project without changing native identity", () => {
    const canonical = issueListRefreshSource(
      nucbox,
      [nucbox],
      { state: "closed", involvement: "assigned", projectId: main.projectId, host: "GITHUB.COM" },
      alias,
      held,
    );
    expect(canonical).toEqual({ ...alias, projectId: main.projectId });
    expect(issueListRefreshSource(nucbox, [nucbox], { state: "all" }, alias, held)).toEqual(
      canonical,
    );
  });
});

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
