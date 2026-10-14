import type {
  IssueLinkedPullRequest,
  IssueRef,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  issueAssigneeOptions,
  issueDisplayLabel,
  issueLabelOptions,
  linkedPullRequestTarget,
  nextIssueAssignees,
} from "./issueDetail.logic";

const actor = (login: string, id: string) => ({ login, name: null, avatarUrl: null, id });

describe("nextIssueAssignees", () => {
  it("adds by native id and keeps every existing assignee, seen in candidates or not", () => {
    expect(
      nextIssueAssignees([actor("alice", "11"), actor("ghost", "99")], actor("bob", "22")),
    ).toEqual(["11", "99", "22"]);
  });

  it("falls back to the login where the tracker gives no id", () => {
    expect(
      nextIssueAssignees(
        [{ login: "octocat", name: null, avatarUrl: null }],
        actor("hubot", "hubot"),
      ),
    ).toEqual(["octocat", "hubot"]);
  });

  it("removes the candidate when it is already assigned", () => {
    expect(
      nextIssueAssignees([actor("Ada", "acc-1"), actor("Bo", "acc-2")], actor("Ada", "acc-1")),
    ).toEqual(["acc-2"]);
  });

  it("replaces the assignee on a single-assignee tracker", () => {
    expect(nextIssueAssignees([actor("Ada", "acc-1")], actor("Bo", "acc-2"), 1)).toEqual(["acc-2"]);
  });
});

describe("linkedPullRequestTarget", () => {
  const link: IssueLinkedPullRequest = {
    repository: "acme/web",
    number: 7,
    title: "Fix it",
    url: "https://github.com/acme/web/pull/7",
    state: "open",
    isDraft: false,
    closesIssue: false,
  };
  const ref = (tracker: string, host?: string): IssueRef =>
    ({ projectId: "p", tracker, ...(host ? { host } : {}), scope: "s", key: "1" }) as IssueRef;

  it("routes with the link's own provider and host, never the tracker's", () => {
    expect(
      linkedPullRequestTarget(
        { ...link, provider: "github" as SourceControlProviderKind, host: "github.com" },
        ref("linear", "linear.app"),
      ),
    ).toEqual({
      projectId: "p",
      host: "github.com",
      repository: "acme/web",
      number: 7,
      url: link.url,
    });
  });

  it("falls back to a git tracker's own kind and host", () => {
    expect(linkedPullRequestTarget(link, ref("gitlab", "gitlab.example.com"))).toMatchObject({
      host: "gitlab.example.com",
    });
  });

  it("does not guess for a standalone tracker without a provider", () => {
    expect(linkedPullRequestTarget(link, ref("linear", "linear.app"))).toBeNull();
  });
});

describe("issueDisplayLabel", () => {
  it("names the repository beside a bare number and leaves a native key alone", () => {
    expect(issueDisplayLabel("demo/atlas", "#42")).toBe("demo/atlas#42");
    expect(issueDisplayLabel("acme/web", "#123")).toBe("acme/web#123");
    expect(issueDisplayLabel("acme/web", "123")).toBe("acme/web#123");
    expect(issueDisplayLabel("ENG", "ENG-123")).toBe("ENG-123");
  });
});

describe("issueLabelOptions", () => {
  const fetched = [{ name: "bug", color: null, description: "Broken" }];

  it("offers applied labels the catalog did not return, once", () => {
    expect(
      issueLabelOptions(
        [
          { name: "bug", color: "f00" },
          { name: "legacy", color: null },
        ],
        fetched,
        "",
      ).map((label) => label.name),
    ).toEqual(["bug", "legacy"]);
  });

  it("finds an applied label beyond the catalog by search", () => {
    expect(issueLabelOptions([{ name: "legacy", color: null }], fetched, "LEG")).toEqual([
      { name: "legacy", color: null, description: null },
    ]);
  });
});

describe("issueAssigneeOptions", () => {
  it("offers current assignees beyond the catalog so they can be removed", () => {
    const options = issueAssigneeOptions(
      [actor("Ada", "acc-1"), { login: "octocat", name: null, avatarUrl: null }],
      [actor("ada-renamed", "ACC-1"), actor("Bo", "acc-2")],
      "",
    );
    expect(options.map((option) => option.id)).toEqual(["ACC-1", "acc-2", "octocat"]);
    expect(nextIssueAssignees([actor("Ada", "acc-1")], options[0]!)).toEqual([]);
  });

  it("searches current assignees by native id", () => {
    expect(
      issueAssigneeOptions([actor("Ada", "acc-9")], [actor("Bo", "acc-2")], "acc-9").map(
        (option) => option.login,
      ),
    ).toEqual(["Ada"]);
  });
});
