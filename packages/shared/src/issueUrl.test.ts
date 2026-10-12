import { describe, expect, it } from "vite-plus/test";
import { parseIssueUrl } from "./issueUrl.ts";

describe("parseIssueUrl", () => {
  it.each([
    ["https://github.com/owner/repo/issues/42#comment", "github", "owner/repo", 42],
    ["https://gitlab.com/group/sub/project/-/issues/12?x=1", "gitlab", "group/sub/project", 12],
    ["https://linear.app/workspace/issue/TEAM-3/title", "linear", "TEAM", 3],
    [
      "https://dev.azure.com/org/Project%20Name/_workitems/edit/5",
      "azure-devops",
      "org/Project Name",
      5,
    ],
    [
      "https://org.visualstudio.com/DefaultCollection/project/_workitems/edit/5",
      "azure-devops",
      "org/project",
      5,
    ],
    ["https://codeberg.org/owner/repo/issues/9", "forgejo", "owner/repo", 9],
  ])("parses %s", (url, provider, repository, number) => {
    expect(parseIssueUrl(url)).toMatchObject({ provider, repository, number });
    expect(parseIssueUrl(url)?.url).not.toMatch(/[?#]/u);
  });

  it("requires a locally resolved provider for a custom host and retains its port", () => {
    const url = "https://git.example.test:8443/owner/repo/issues/1";
    expect(parseIssueUrl(url)).toBeNull();
    expect(parseIssueUrl(url, { provider: "forgejo" })).toMatchObject({
      host: "git.example.test:8443",
      provider: "forgejo",
    });
    expect(
      parseIssueUrl("https://github.com/owner/repo/issues/1", { provider: "gitlab" }),
    ).toBeNull();
    expect(
      parseIssueUrl("http://git.example.test/owner/repo/issues/1", { provider: "forgejo" })?.url,
    ).toBe("http://git.example.test/owner/repo/issues/1");
    expect(
      parseIssueUrl("http://github.com/owner/repo/issues/1", { provider: "github" }),
    ).toBeNull();
    expect(parseIssueUrl("https://bitbucket.org/owner/repo/issues/1/title")?.number).toBe(1);
    expect(parseIssueUrl("https://org.visualstudio.com/project/_workitems/edit/5")?.url).toBe(
      "https://dev.azure.com/org/project/_workitems/edit/5",
    );
    expect(parseIssueUrl("https://gitlab.com/group/repo/-/work_items/5")?.url).toBe(
      "https://gitlab.com/group/repo/-/issues/5",
    );
  });

  it.each([
    "http://github.com/owner/repo/issues/1",
    "https://github.com:444/owner/repo/issues/1",
    "https://user:password@github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/issues/0",
    "https://github.com/owner/repo/issues/9007199254740992",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner%2frepo/issues/1",
    "https://github.com/owner%00/repo/issues/1",
    "https://github.com/owner/repo/issues/1/extra",
    "https://linear.app/workspace/issue/not-a-key",
    "https://dev.azure.com/org/_workitems/edit/1",
  ])("rejects an unsafe or invalid target %s", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });
});
