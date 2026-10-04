import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: vi.fn() },
}));

import { findLinkedIssue, parseIssueUrl, resolveIssueReference } from "./issueReference";

const projects = [
  {
    id: "p1",
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/t3code",
      provider: "github",
      displayName: "pingdotgg/t3code",
      owner: "pingdotgg",
      name: "t3code",
    },
  },
  {
    id: "p3",
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/docs",
      provider: "github",
      displayName: "pingdotgg/docs",
      owner: "pingdotgg",
      name: "docs",
    },
  },
  {
    id: "p2",
    repositoryIdentity: {
      canonicalKey: "gitlab.example.com/team/platform/api",
      provider: "gitlab",
      displayName: "team/platform/api",
      owner: "team",
      name: "api",
    },
  },
] as never;

describe("parseIssueUrl", () => {
  it.each([
    ["https://github.com/pingdotgg/t3code/issues/42#top", "pingdotgg/t3code", 42],
    ["https://github.com/pingdotgg/t3code/issues/42/", "pingdotgg/t3code", 42],
    // Any host: a GitHub Enterprise install, gated later on a project for that host.
    ["https://git.corp.example/pingdotgg/t3code/issues/42", "pingdotgg/t3code", 42],
    ["https://gitlab.example.com/team/platform/api/-/work_items/7", "team/platform/api", 7],
    ["https://gitlab.example.com/team/platform/api/-/issues/7?x=1#note_3", "team/platform/api", 7],
  ])("reads %s", (url, repository, number) => {
    expect(parseIssueUrl(url)).toMatchObject({ repository, number });
  });

  it.each([
    "https://github.com/pingdotgg/t3code/pull/42",
    "https://github.com/pingdotgg/t3code/issues/42/whatever",
    "https://gitlab.example.com/groups/team/-/work_items/7",
    "ftp://github.com/pingdotgg/t3code/issues/42",
  ])("ignores %s", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });
});

describe("resolveIssueReference", () => {
  const resolve = (reference: string) =>
    resolveIssueReference({ reference, projects, projectId: "p1" as never });

  it("reads #42 and a bare 42 through the thread's project", () => {
    const ref = { ref: { projectId: "p1", repository: "pingdotgg/t3code", number: 42 } };
    expect(resolve("#42")).toEqual(ref);
    expect(resolve("42")).toEqual(ref);
  });

  it("reads owner/repo#42 through the project that holds that repository on the same host", () => {
    expect(resolve("PingDotGG/Docs#9")).toEqual({
      ref: { projectId: "p3", repository: "PingDotGG/Docs", number: 9 },
    });
    // The server reads issues only through their own project, so this would fail after a read.
    expect(resolve("pingdotgg/other#9")).toEqual({
      error: "No project in this environment can read pingdotgg/other.",
    });
    // Same path, other host.
    expect(resolve("team/platform/api#9")).toEqual({
      error: "No project in this environment can read team/platform/api.",
    });
    expect(resolve("pingdotgg/other9")).toBeNull();
  });

  it("reads a URL through the project that owns its repository", () => {
    expect(resolve("https://gitlab.example.com/team/platform/api/-/issues/3")).toEqual({
      ref: { projectId: "p2", repository: "team/platform/api", number: 3 },
    });
    expect(resolve("https://github.com/someone/else/issues/3")).toEqual({
      error: "No project in this environment can read someone/else.",
    });
  });
});

describe("findLinkedIssue", () => {
  const link = (url: string, repository = "team/platform/api", number = 7) => ({
    provider: "gitlab",
    repository,
    number,
    url,
    title: "An issue",
  });

  it.each([
    "https://gitlab.example.com/team/platform/api/-/work_items/7",
    "https://gitlab.example.com/team/platform/api/-/issues/7/",
    "https://GitLab.Example.com/Team/Platform/API/-/issues/7#note_1",
    "http://www.gitlab.example.com/team/platform/api/-/issues/7",
  ])("finds the link stored as /-/issues/7 from %s", (url) => {
    const stored = link("https://gitlab.example.com/team/platform/api/-/issues/7");
    expect(findLinkedIssue([stored], url)).toBe(stored);
  });

  it("does not match the same number in another repository or host", () => {
    const stored = link("https://gitlab.example.com/team/platform/api/-/issues/7");
    expect(
      findLinkedIssue([stored], "https://gitlab.example.com/team/platform/web/-/issues/7"),
    ).toBeNull();
    expect(findLinkedIssue([stored], "https://gitlab.com/team/platform/api/-/issues/7")).toBeNull();
  });

  it("matches a tracker URL it cannot parse by the stored URL", () => {
    const stored = {
      ...link("https://linear.app/acme/issue/ENG-7/title", "ENG", 7),
      provider: "linear",
    };
    expect(findLinkedIssue([stored], "https://linear.app/acme/issue/ENG-7/title?x=1")).toBe(stored);
    expect(findLinkedIssue([stored], "https://linear.app/acme/issue/ENG-8/title")).toBeNull();
  });
});
