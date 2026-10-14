import { describe, expect, it } from "vite-plus/test";
import { IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import {
  issueAccess,
  issueReactionAllowed,
  issueReactionOptions,
  ISSUE_REACTIONS,
  issueAssigneeId,
  issueCreateBlocked,
  issueTimeline,
  resolveIssueType,
} from "./issueDetail";

function detail(): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "team",
    key: "TEAM-1",
    displayKey: "TEAM-1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Issue",
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "In progress" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [],
    commentsCursor: null,
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
      linkedPullRequests: true,
      events: true,
      search: true,
      states: [
        { category: "open", name: "IN PROGRESS" },
        { category: "closed", name: "Done" },
      ],
      closeReasons: ["completed"],
    },
    viewerPermissions: {
      setState: true,
      comment: true,
      edit: true,
      labels: true,
      assignees: true,
    },
  };
}

const grants = { connected: true, comment: true, update: true, setState: true, react: true };
const denied = {
  comment: false,
  react: false,
  commentReact: false,
  edit: false,
  labels: false,
  assignees: false,
  states: [],
  closeReasons: [],
};

describe("issue access", () => {
  it("requires a reaction grant and capability but no unrelated viewer permission", () => {
    const issue = detail();
    expect(issueAccess(issue, { ...grants, react: false }).react).toBe(false);
    expect(
      issueAccess({ ...issue, capabilities: { ...issue.capabilities, reactions: false } }, grants)
        .react,
    ).toBe(false);
    expect(
      issueAccess(
        {
          ...issue,
          viewerPermissions: {
            setState: false,
            comment: false,
            edit: false,
            labels: false,
            assignees: false,
          },
        },
        grants,
      ).react,
    ).toBe(true);
    expect(ISSUE_REACTIONS.map((reaction) => reaction.content)).toEqual([
      "thumbs-up",
      "thumbs-down",
      "laugh",
      "hooray",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]);
  });

  it("requires detail, connection, and a writable issue for all actions", () => {
    expect(issueAccess(null, grants)).toEqual(denied);
    expect(issueAccess({ ...detail(), writable: false }, grants)).toEqual(denied);
    expect(issueAccess(detail(), { ...grants, connected: false })).toEqual(denied);
  });

  it("requires each command grant and excludes the current state without case sensitivity", () => {
    expect(issueAccess(detail(), grants)).toEqual({
      comment: true,
      react: true,
      commentReact: true,
      edit: true,
      labels: true,
      assignees: true,
      states: [{ category: "closed", name: "Done" }],
      closeReasons: ["completed"],
    });
    expect(issueAccess(detail(), { ...grants, comment: false }).comment).toBe(false);
    expect(issueAccess(detail(), { ...grants, update: false })).toMatchObject({
      comment: true,
      edit: false,
      labels: false,
      assignees: false,
    });
    expect(issueAccess(detail(), { ...grants, setState: false })).toMatchObject({
      states: [],
      closeReasons: [],
    });
  });

  it.each(["comment", "edit", "labels", "assignees"] as const)(
    "requires the %s capability and viewer permission",
    (action) => {
      const issue = detail();
      expect(
        issueAccess({ ...issue, capabilities: { ...issue.capabilities, [action]: false } }, grants)[
          action
        ],
      ).toBe(false);
      expect(
        issueAccess(
          { ...issue, viewerPermissions: { ...issue.viewerPermissions, [action]: false } },
          grants,
        )[action],
      ).toBe(false);
    },
  );

  it("does not offer whole-set label edits when the current labels are truncated", () => {
    expect(issueAccess({ ...detail(), labelsTruncated: true }, grants)).toMatchObject({
      labels: false,
      edit: true,
      assignees: true,
    });
    expect(issueAccess({ ...detail(), labelsTruncated: false }, grants).labels).toBe(true);
    expect(issueAccess(detail(), grants).labels).toBe(true);
  });

  it("does not offer state changes or close reasons when the viewer cannot set state", () => {
    const issue = detail();
    expect(
      issueAccess(
        { ...issue, viewerPermissions: { ...issue.viewerPermissions, setState: false } },
        grants,
      ),
    ).toMatchObject({ states: [], closeReasons: [] });
    expect(
      issueAccess({ ...issue, capabilities: { ...issue.capabilities, states: [] } }, grants),
    ).toMatchObject({ states: [], closeReasons: [] });
  });
});

describe("issue reaction capabilities", () => {
  const contents = ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart"] as const;
  const azure = () => ({
    ...detail(),
    tracker: IssueTrackerKind.make("azure-devops"),
    capabilities: {
      ...detail().capabilities,
      reactions: false,
      commentReactions: true,
      reactionContents: contents,
    },
  });

  it("uses legacy reaction capability for both subjects when comment capability is absent", () => {
    expect(issueAccess(detail(), grants)).toMatchObject({ react: true, commentReact: true });
    const issue = detail();
    expect(
      issueAccess({ ...issue, capabilities: { ...issue.capabilities, reactions: false } }, grants),
    ).toMatchObject({ react: false, commentReact: false });
  });

  it("enables Azure native comment reactions while keeping issue reactions read-only", () => {
    expect(issueAccess(azure(), grants)).toMatchObject({ react: false, commentReact: true });
    const issue = detail();
    expect(
      issueAccess(
        { ...issue, capabilities: { ...issue.capabilities, commentReactions: false } },
        grants,
      ),
    ).toMatchObject({ react: true, commentReact: false });
  });

  it("uses the same connection, write and reaction grant for comments without unrelated viewer permissions", () => {
    expect(issueAccess(azure(), { ...grants, connected: false }).commentReact).toBe(false);
    expect(issueAccess({ ...azure(), writable: false }, grants).commentReact).toBe(false);
    expect(issueAccess(azure(), { ...grants, react: false }).commentReact).toBe(false);
    expect(
      issueAccess(
        {
          ...azure(),
          viewerPermissions: {
            setState: false,
            comment: false,
            edit: false,
            labels: false,
            assignees: false,
          },
        },
        grants,
      ).commentReact,
    ).toBe(true);
  });

  it("keeps all eight legacy menu options, only offers Azure native six, and treats an empty list as none", () => {
    expect(issueReactionOptions().map((option) => option.content)).toEqual(
      ISSUE_REACTIONS.map((option) => option.content),
    );
    expect(issueReactionOptions(contents).map((option) => option.content)).toEqual(contents);
    expect(issueReactionOptions([])).toEqual([]);
  });

  it("allows supported comments from any loaded page and rejects unsupported subjects or content", () => {
    const issue = azure();
    const access = issueAccess(issue, grants);
    const comments = [
      {
        id: "older",
        author: null,
        body: "",
        createdAt: "2026-10-01T00:00:00Z",
        url: null,
        reactions: [],
      },
      { id: "read-only", author: null, body: "", createdAt: "2026-10-01T00:00:00Z", url: null },
    ];
    expect(issueReactionAllowed(issue, access, "heart", "older", comments)).toBe(true);
    expect(issueReactionAllowed(issue, access, "heart")).toBe(false);
    expect(issueReactionAllowed(issue, access, "rocket", "older", comments)).toBe(false);
    expect(issueReactionAllowed(issue, access, "eyes", "older", comments)).toBe(false);
    expect(issueReactionAllowed(issue, access, "heart", "read-only", comments)).toBe(false);
    expect(issueReactionAllowed(issue, access, "heart", "unknown", comments)).toBe(false);
    const legacy = { ...detail(), comments };
    expect(issueReactionAllowed(legacy, issueAccess(legacy, grants), "rocket")).toBe(true);
    expect(issueReactionAllowed(legacy, issueAccess(legacy, grants), "eyes", "older")).toBe(true);
  });

  it("allows no reaction writes when the native content list is empty", () => {
    const issue = detail();
    expect(
      issueAccess(
        { ...issue, capabilities: { ...issue.capabilities, reactionContents: [] } },
        grants,
      ),
    ).toMatchObject({ react: false, commentReact: false });
  });
});

describe("issue assignee identity", () => {
  it("prefers the native id over the login name", () => {
    expect(
      issueAssigneeId({ id: "native-uuid", login: "viewer", name: null, avatarUrl: null }),
    ).toBe("native-uuid");
    expect(issueAssigneeId({ login: "legacy", name: null, avatarUrl: null })).toBe("legacy");
  });
});

describe("issue timeline", () => {
  it("orders oldest first and keeps equal-time items in input order", () => {
    const comments = [
      { id: "late", author: null, body: "Late", createdAt: "2026-10-03T00:00:00Z", url: null },
      { id: "same", author: null, body: "Same", createdAt: "2026-10-02T00:00:00Z", url: null },
    ];
    const events = [
      {
        id: "early",
        kind: "assigned" as const,
        actor: null,
        createdAt: "2026-10-01T00:00:00Z",
        detail: null,
      },
      {
        id: "same-event",
        kind: "closed" as const,
        actor: null,
        createdAt: "2026-10-02T00:00:00Z",
        detail: null,
      },
    ];
    expect(
      issueTimeline(comments, events).map((item) =>
        item.kind === "comment" ? item.comment.id : item.event.id,
      ),
    ).toEqual(["early", "same", "same-event", "late"]);
    expect(comments[0]?.id).toBe("late");
  });
});

describe("issue creation", () => {
  const input = {
    hasScope: true,
    canWrite: true,
    templates: null,
    blankChosen: true,
    issueTypes: null,
  };
  it("resolves a single type automatically and rejects a stale choice", () => {
    expect(resolveIssueType([{ id: "bug" }], null)).toBe("bug");
    expect(resolveIssueType([{ id: "bug" }, { id: "task" }], "task")).toBe("task");
    expect(resolveIssueType([{ id: "bug" }, { id: "task" }], "removed")).toBeNull();
  });
  it("keeps the web's scope, write, template, and issue type messages", () => {
    expect(issueCreateBlocked(input)).toBeNull();
    expect(issueCreateBlocked({ ...input, hasScope: false })).toBe(
      "No project here can file issues.",
    );
    expect(issueCreateBlocked({ ...input, canWrite: false })).toBe(
      "Creating issues needs the source-control write scope.",
    );
    expect(issueCreateBlocked({ ...input, templates: { pending: true, list: null } })).toBe(
      "Loading templates…",
    );
    expect(
      issueCreateBlocked({
        ...input,
        templates: { pending: false, list: { blankIssuesEnabled: false, templates: [{}] } },
      }),
    ).toBe("This tracker requires a template.");
    expect(
      issueCreateBlocked({
        ...input,
        templates: { pending: false, list: { blankIssuesEnabled: false, templates: [] } },
      }),
    ).toBe("This tracker requires a template, and none can be filled in here.");
    expect(
      issueCreateBlocked({
        ...input,
        blankChosen: false,
        templates: { pending: true, list: null },
      }),
    ).toBe("Loading templates…");
    const types = { pending: false, error: null, count: 2, chosen: null };
    expect(issueCreateBlocked({ ...input, issueTypes: types })).toBe("Choose an issue type.");
    expect(issueCreateBlocked({ ...input, issueTypes: { ...types, pending: true } })).toBe(
      "Loading issue types…",
    );
    expect(issueCreateBlocked({ ...input, issueTypes: { ...types, error: "Read failed" } })).toBe(
      "Issue types could not be read: Read failed",
    );
    expect(issueCreateBlocked({ ...input, issueTypes: { ...types, count: 0 } })).toBe(
      "This project offers no issue types.",
    );
    expect(issueCreateBlocked({ ...input, issueTypes: { ...types, chosen: "bug" } })).toBeNull();
  });
  it("blocks creation after a failed template read until a retry supplies the blank policy", () => {
    expect(issueCreateBlocked({ ...input, templates: { pending: false, list: null } })).toBe(
      "Templates could not be read.",
    );
    expect(
      issueCreateBlocked({
        ...input,
        templates: { pending: false, list: { blankIssuesEnabled: true, templates: [] } },
      }),
    ).toBeNull();
  });
  it("unblocks creation when an issue type retry succeeds and keeps the chosen type", () => {
    const failed = { pending: false, error: "Read failed", count: 0, chosen: null };
    expect(issueCreateBlocked({ ...input, issueTypes: failed })).toBe(
      "Issue types could not be read: Read failed",
    );
    expect(issueCreateBlocked({ ...input, issueTypes: { ...failed, pending: true } })).toBe(
      "Loading issue types…",
    );
    const types = [{ id: "bug" }, { id: "task" }];
    const chosen = resolveIssueType(types, "task");
    expect(
      issueCreateBlocked({
        ...input,
        issueTypes: { pending: false, error: null, count: types.length, chosen },
      }),
    ).toBeNull();
  });
});
