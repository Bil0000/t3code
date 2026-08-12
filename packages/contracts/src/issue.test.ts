import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  IssueCreateInput,
  IssueDetail,
  IssueListInput,
  IssueListResult,
  IssueTemplateList,
  IssueUpdateInput,
} from "./issue.ts";

const decodeListResult = Schema.decodeUnknownSync(IssueListResult);
const decodeListInput = Schema.decodeUnknownSync(IssueListInput);
const decodeCreate = Schema.decodeUnknownSync(IssueCreateInput);
const decodeUpdate = Schema.decodeUnknownSync(IssueUpdateInput);

const LIST_RESULT: IssueListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: "gitlab",
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: "github",
      host: "github.com",
      projectId: "project-1" as IssueListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 7,
      title: "The list does not refresh after a close",
      url: "https://github.com/pingdotgg/t3code/issues/7",
      author: { login: "octocat", name: null, avatarUrl: null },
      state: "open",
      stateReason: null,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: null,
      assignees: [{ login: "hubot", name: "Hubot", avatarUrl: null }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: null,
      commentCount: 3,
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|7" },
};

describe("IssueListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record with
   * an optional value, for one — fails as an interrupted request rather than as a schema error.
   * Building it here turns that into a test failure instead.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueListResult);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });

  it("keys a viewer by host, so two hosts of one kind stay separate accounts", () => {
    const decoded = decodeListResult({
      ...LIST_RESULT,
      viewers: { "github.com": "bilal", "github.acme.dev": "b.hassan" },
    });

    expect(decoded.viewers["github.com"]).toBe("bilal");
    expect(decoded.viewers["github.acme.dev"]).toBe("b.hassan");
  });

  it("keeps why an issue was closed, which is not the same as that it was closed", () => {
    const entry = { ...LIST_RESULT.entries[0], state: "closed", stateReason: "not-planned" };

    expect(decodeListResult({ ...LIST_RESULT, entries: [entry] }).entries[0]?.stateReason).toBe(
      "not-planned",
    );
  });
});

describe("IssueListInput", () => {
  it("trims a search, so what is sent is what was typed", () => {
    expect(decodeListInput({ state: "open", query: "  refresh  " }).query).toBe("refresh");
  });

  it("bounds a search, because it travels into a command and a query string", () => {
    expect(decodeListInput({ state: "open", query: "p".repeat(200) }).query).toHaveLength(200);
    expect(() => decodeListInput({ state: "open", query: "p".repeat(201) })).toThrow();
  });

  it("takes back the continuation a result handed out, keyed the way it arrived", () => {
    const cursors = { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|99|7,8" };

    expect(decodeListInput({ state: "open", cursors }).cursors).toStrictEqual(cursors);
  });

  it("bounds a continuation, because it comes back from the page and goes into a filter", () => {
    const long = (length: number) => ({ "github.com acme/web": "c".repeat(length) });
    expect(decodeListInput({ state: "open", cursors: long(4096) })).toBeDefined();
    expect(() => decodeListInput({ state: "open", cursors: long(4097) })).toThrow();
  });
});

describe("IssueCreateInput", () => {
  const base = { projectId: "p1", repository: "acme/web", title: "Crash on open", labels: [] };

  it("takes an issue with a title and nothing else, which is a legitimate one", () => {
    expect(decodeCreate({ ...base, body: "", assignees: [] }).body).toBe("");
  });

  it("refuses an issue with no title, which no host would file", () => {
    expect(() => decodeCreate({ ...base, title: "   ", body: "", assignees: [] })).toThrow();
  });

  it("bounds the labels and assignees, because they travel into a body the page composed", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `entry${index}`);
    expect(decodeCreate({ ...base, body: "", assignees: many(25) }).assignees).toHaveLength(25);
    expect(() => decodeCreate({ ...base, body: "", assignees: many(26) })).toThrow();
    expect(() => decodeCreate({ ...base, labels: many(51), body: "", assignees: [] })).toThrow();
  });
});

describe("IssueUpdateInput", () => {
  const ref = { projectId: "p1", repository: "acme/web", number: 7 };

  it("carries only what was edited, so a rename does not resend a body nobody touched", () => {
    const decoded = decodeUpdate({ ...ref, title: "Crash on open" });

    expect(decoded.title).toBe("Crash on open");
    expect(decoded.body).toBeUndefined();
  });

  // Not trimmed: a body is markdown, where leading spaces open a code block and two trailing
  // spaces are a line break.
  it("leaves a body exactly as it was written", () => {
    expect(decodeUpdate({ ...ref, body: "    indented\n" }).body).toBe("    indented\n");
  });
});

describe("IssueDetail", () => {
  it("carries the change requests that reference it, marking the ones that close it", () => {
    const detail = Schema.decodeUnknownSync(IssueDetail)({
      provider: "github",
      capabilities: {
        comment: true,
        actions: ["close", "reopen"],
        closeReasons: ["completed", "not-planned"],
        create: true,
        issueTemplates: true,
        edit: true,
        labels: true,
        assignees: true,
        listLabelCandidates: true,
        listAssigneeCandidates: true,
        search: true,
        linkedPullRequests: true,
        timelineEvents: true,
      },
      viewerPermissions: {
        actions: ["close"],
        comment: true,
        edit: true,
        labels: true,
        assignees: true,
        create: true,
      },
      projectId: "project-1",
      projectTitle: "t3code",
      workspaceRoot: "/home/bilal/t3code",
      repository: "pingdotgg/t3code",
      number: 7,
      title: "The list does not refresh after a close",
      body: "Steps to reproduce",
      url: "https://github.com/pingdotgg/t3code/issues/7",
      author: { login: "octocat", name: null, avatarUrl: null },
      state: "open",
      stateReason: null,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: null,
      assignees: [],
      labels: [],
      milestone: null,
      commentCount: 0,
      linkedPullRequests: [
        {
          repository: "pingdotgg/t3code",
          number: 12,
          title: "Refresh the list after a close",
          url: "https://github.com/pingdotgg/t3code/pull/12",
          state: "open",
          isDraft: false,
          closesIssue: true,
        },
      ],
    });

    expect(detail.linkedPullRequests.map((entry) => entry.closesIssue)).toEqual([true]);
  });
});

describe("IssueTemplateList", () => {
  const TEMPLATES: IssueTemplateList = {
    templates: [
      {
        key: "bug_report.md",
        name: "Bug report",
        about: "Something is broken",
        title: "[Bug]: ",
        body: "### What happened\n\n",
        labels: ["bug"],
        assignees: ["octocat"],
      },
      // A GitLab template, which carries a body and nothing else.
      {
        key: "Default",
        name: "Default",
        about: "",
        title: "",
        body: "## Summary\n",
        labels: [],
        assignees: [],
      },
    ],
    contactLinks: [
      {
        name: "Ask a question",
        about: "Anything that is not a defect",
        url: "https://github.com/pingdotgg/t3code/discussions",
      },
    ],
    blankIssuesEnabled: false,
  };

  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueTemplateList);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(TEMPLATES));

    expect(decoded).toStrictEqual(TEMPLATES);
  });

  // Not trimmed: a template body is markdown a repository wrote deliberately, headings, blank
  // lines and all, and the form it opens has to show exactly what the repository asks for.
  it("leaves a template body exactly as the repository wrote it", () => {
    const decoded = Schema.decodeUnknownSync(IssueTemplateList)({
      ...TEMPLATES,
      templates: [{ ...TEMPLATES.templates[0], body: "  indented\n\n" }],
    });

    expect(decoded.templates[0]?.body).toBe("  indented\n\n");
  });

  it("takes a repository that offers nothing, which is where the blank form comes from", () => {
    const decoded = Schema.decodeUnknownSync(IssueTemplateList)({
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });

    expect(decoded.templates).toEqual([]);
    expect(decoded.blankIssuesEnabled).toBe(true);
  });
});
