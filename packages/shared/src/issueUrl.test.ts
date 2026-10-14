import { describe, expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./issueUrl.ts";

describe("parseIssueUrl", () => {
  it("uses the configured tracker before a hostname that resembles another provider", () => {
    const url = "https://github.company.net/team/repo/issues/7";
    expect(parseIssueUrl(url)?.tracker).toBe("github");
    expect(parseIssueUrl(url, { tracker: "forgejo", host: "github.company.net" })?.tracker).toBe(
      "forgejo",
    );
    expect(parseIssueUrl(url, { tracker: "forgejo", host: "other.company.net" })?.tracker).toBe(
      "github",
    );
  });
  it.each([
    [
      "https://github.com/T3Tools/T3Code/issues/123",
      { tracker: "github", host: "github.com", scope: "t3tools/t3code", key: "123" },
    ],
    [
      "https://github.acme.test/platform/api/issues/7#issuecomment-1",
      { tracker: "github", host: "github.acme.test", scope: "platform/api", key: "7" },
    ],
    [
      "https://gitlab.com/group/sub/repo/-/issues/42",
      { tracker: "gitlab", host: "gitlab.com", scope: "group/sub/repo", key: "42" },
    ],
    [
      "https://git.internal/team/repo/-/issues/9",
      { tracker: "gitlab", host: "git.internal", scope: "team/repo", key: "9" },
    ],
    [
      "https://dev.azure.com/Org/Project/_workitems/edit/55",
      { tracker: "azure-devops", host: "dev.azure.com", scope: "org/project", key: "55" },
    ],
    [
      "https://codeberg.org/forgejo/forgejo/issues/3",
      { tracker: "forgejo", host: "codeberg.org", scope: "forgejo/forgejo", key: "3" },
    ],
    [
      "https://linear.app/acme/issue/ENG-123/fix-the-bug?view=all#comment",
      { tracker: "linear", host: "linear.app", scope: "eng", key: "ENG-123", workspace: "acme" },
    ],
    [
      "https://tenant.atlassian.net/browse/ENG-123?focusedCommentId=42",
      { tracker: "jira", host: "tenant.atlassian.net", scope: "eng", key: "ENG-123" },
    ],
  ])("reads %s", (url, expected) => {
    expect(parseIssueUrl(url)).toEqual(expected);
  });

  it.each([
    "https://github.com/T3Tools/T3Code/pull/123",
    "https://github.com/T3Tools/T3Code/issues",
    "https://example.com/owner/repo/issues/1",
    "https://linear.app/acme/issue/ENG-0",
    "https://linear.app/acme/issue/ENG-123/title/another-path",
    "https://linear.app.evil.test/acme/issue/ENG-123",
    "http://linear.app/acme/issue/ENG-123",
    "https://linear.app:8443/acme/issue/ENG-123",
    "https://tenant.atlassian.net/browse/ENG-0",
    "https://tenant.atlassian.net/browse/ENG-123/another-path",
    "https://tenant.atlassian.net.evil.test/browse/ENG-123",
    "https://example.com/browse/ENG-123",
    "javascript:alert(1)",
    "not a url",
  ])("leaves %s alone", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });

  it.each(["github", "forgejo"])(
    "reads a configured %s host without guessing its name",
    (tracker) => {
      const url = "https://git.acme.test/team/repo/issues/7";
      expect(parseIssueUrl(url)).toBeNull();
      expect(parseIssueUrl(url, { tracker, host: "git.acme.test" })).toEqual({
        tracker,
        host: "git.acme.test",
        scope: "team/repo",
        key: "7",
      });
      expect(parseIssueUrl(url, { tracker, host: "other.acme.test" })).toBeNull();
    },
  );
});
