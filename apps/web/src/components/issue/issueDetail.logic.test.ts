import type {
  IssueComment,
  IssueDetail,
  IssueLinkedPullRequest,
  IssueRef,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOlderIssueComments,
  issueAssigneeOptions,
  issueCommentsView,
  issueSupportsReactions,
  offeredIssueReactionContents,
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

const comment = (id: string, reactions?: IssueComment["reactions"]): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00Z",
  url: null,
  ...(reactions === undefined ? {} : { reactions }),
});

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Issue",
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 3,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [comment("c3")],
    commentsCursor: "page-2",
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    ...patch,
  };
}

const heart = [{ content: "heart" as const, count: 1, actors: [], viewerHasReacted: false }];
describe("older issue comments across detail re-reads", () => {
  const first = detail();
  const loaded = appendOlderIssueComments(first, null, {
    comments: [comment("c2", heart)],
    nextCursor: "page-3",
  });

  it("keeps loaded pages when a new detail has the same first-page IDs and cursor", () => {
    const refreshed = detail({
      title: "Renamed",
      comments: [{ ...comment("c3", heart), body: "Updated" }],
    });
    const view = issueCommentsView(refreshed, loaded);
    expect(view.held).toBe(loaded);
    expect(view.comments.map((each) => each.id)).toEqual(["c2", "c3"]);
    expect(view.comments[1]).toEqual(refreshed.comments[0]);
    expect(view.cursor).toBe("page-3");
  });

  it("restarts a shifted Jira head with the same offset and eventually includes every boundary comment", () => {
    const comments = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => comment(String(from + index)));
    const before = detail({
      tracker: IssueTrackerKind.make("jira"),
      host: "workspace.atlassian.net",
      scope: "PROJ",
      comments: comments(101, 150),
      commentsCursor: "50",
      commentCount: 150,
    });
    const loaded = appendOlderIssueComments(before, null, {
      comments: comments(51, 100),
      nextCursor: "100",
    });
    const after = { ...before, comments: comments(102, 151), commentCount: 151 };
    const shifted = issueCommentsView(after, loaded);
    expect(shifted.held).toBeNull();
    expect(shifted.cursor).toBe("50");
    expect(shifted.comments).toHaveLength(50);
    const page2 = appendOlderIssueComments(after, shifted.held, {
      comments: comments(52, 101),
      nextCursor: "100",
    });
    const page3 = appendOlderIssueComments(after, page2, {
      comments: comments(2, 51),
      nextCursor: "150",
    });
    const page4 = appendOlderIssueComments(after, page3, {
      comments: comments(1, 1),
      nextCursor: null,
    });
    const complete = issueCommentsView(after, page4);
    expect(complete.comments.map((each) => each.id)).toEqual(
      comments(1, 151).map((each) => each.id),
    );
    expect(complete.cursor).toBeNull();
  });

  it("drops them when the first page now ends elsewhere or the issue is another one", () => {
    const moved = issueCommentsView(detail({ commentsCursor: "page-2b" }), loaded);
    expect(moved.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(moved.cursor).toBe("page-2b");
    const other = issueCommentsView(detail({ key: "2" }), loaded);
    expect(other.comments.map((each) => each.id)).toEqual(["c3"]);
  });
});

describe("issue reaction capabilities", () => {
  it("allows Azure comment reactions without offering issue reactions", () => {
    const azure = { reactions: false, commentReactions: true };
    expect(issueSupportsReactions(azure, false)).toBe(false);
    expect(issueSupportsReactions(azure, true)).toBe(true);
    expect(offeredIssueReactionContents(["thumbs-up"])).toEqual(["thumbs-up"]);
  });
  it("honors an explicit comment restriction and older tracker capabilities", () => {
    expect(issueSupportsReactions({ reactions: true, commentReactions: false }, true)).toBe(false);
    expect(issueSupportsReactions({ reactions: true }, true)).toBe(true);
    expect(offeredIssueReactionContents([])).toEqual([]);
    expect(offeredIssueReactionContents(undefined)).toHaveLength(8);
  });
});
