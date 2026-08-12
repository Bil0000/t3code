import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueWriteJson,
  decodeAssigneeCandidatesJson,
  decodeCreatedIssueJson,
  decodeIssueActivityJson,
  decodeIssueCommentsJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueSearchJson,
  decodeIssueSupplementJson,
  decodeIssueTemplateConfigYaml,
  decodeIssueTemplatesJson,
  decodeIssueViewerPermissionsJson,
  decodeRepositoryLabelsJson,
  DEFAULT_ISSUE_TEMPLATE_CONFIG,
  encodeGraphQlRequestJson,
  issueSearchGraphQlQuery,
  ISSUE_DETAIL_JSON_FIELDS,
  ISSUE_LIST_JSON_FIELDS,
  ISSUE_SEARCH_MAX_ROWS,
} from "./gitHubIssueJson.ts";

/** One row as `gh issue list --json` spells it, which is the shape `gh issue view` answers in. */
function issueJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    number: 1,
    title: "The page never loads",
    url: "https://github.com/acme/web/issues/1",
    state: "OPEN",
    stateReason: "",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    ...entry,
  });
}

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return `[${entries.map((entry) => issueJson(entry)).join(",")}]`;
}

/** One row as the cross-repository search answers it: the listing's row one connection deeper. */
function searchItem(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 7,
    title: "The page never loads",
    url: "https://github.com/acme/web/issues/7",
    author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    repository: { nameWithOwner: "acme/web" },
    ...entry,
  };
}

function searchJson(nodes: ReadonlyArray<unknown>, hasNextPage = false): string {
  return JSON.stringify({ data: { search: { pageInfo: { hasNextPage }, nodes } } });
}

/** A change request as a reference to it names it, wherever GitHub found the reference. */
function pullRequestRef(
  number: number,
  entry: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: "PullRequest",
    number,
    title: `Fix the page (${number})`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    repository: { nameWithOwner: "acme/web" },
    ...entry,
  };
}

function supplementJson(input: {
  readonly viewerPermission?: string | null;
  readonly issue?: Record<string, unknown> | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        viewerPermission: input.viewerPermission ?? "READ",
        issue: input.issue === undefined ? {} : input.issue,
      },
    },
  });
}

function activityJson(input: {
  readonly author?: Record<string, unknown> | null;
  readonly comments?: Record<string, unknown> | null;
  readonly timeline?: ReadonlyArray<unknown>;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          author: input.author ?? null,
          comments: input.comments ?? { totalCount: 0, nodes: [] },
          timelineItems: { nodes: input.timeline ?? [] },
        },
      },
    },
  });
}

function timelineEvent(typename: string, entry: Record<string, unknown> = {}): unknown {
  return {
    __typename: typename,
    id: `${typename}-1`,
    createdAt: "2026-07-03T00:00:00Z",
    actor: { login: "julius", avatarUrl: "https://avatars/julius" },
    ...entry,
  };
}

/** One form as GitHub's GraphQL reports it, name and all. */
function templateEntry(entry: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: "bug_report.md",
    name: "Bug report",
    about: "File a bug",
    title: "Bug: ",
    body: "### Steps",
    assignees: { nodes: [{ login: "julius" }] },
    labels: { nodes: [{ name: "bug" }] },
    ...entry,
  };
}

function issueTemplatesJson(issueTemplates: unknown): string {
  return JSON.stringify({ data: { repository: { issueTemplates } } });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("issue list decoding", () => {
  it("reads an issue with its people, labels and milestone", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          {
            number: 42,
            author: { login: "bilal", name: "Bilal" },
            assignees: [{ login: "julius", name: "Julius" }, { login: "  " }],
            labels: [{ name: "bug", color: "d73a4a" }, { name: "   " }],
            milestone: { title: "v2" },
          },
        ]),
      ),
    );

    expect(batch.items[0]).toMatchObject({
      number: 42,
      state: "open",
      stateReason: null,
      // No `gh` JSON field carries an avatar, so a listing row has initials to show and no face.
      author: { login: "bilal", name: "Bilal", avatarUrl: null },
      // A person and a label GitHub named nothing for are left out rather than shown blank.
      assignees: [{ login: "julius", name: "Julius", avatarUrl: null }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: "v2",
      // The listing never asks for the conversation, so a row from it counts none.
      commentCount: 0,
    });
  });

  it("reads why a closed issue was closed, and nothing for one still open", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-07-03T00:00:00Z" },
          { state: "CLOSED", stateReason: "NOT_PLANNED" },
          // GitHub says an issue opened again was reopened, which is not why it was closed.
          { stateReason: "REOPENED" },
        ]),
      ),
    );

    expect(batch.items.map((item) => [item.state, item.stateReason, item.closedAt])).toEqual([
      ["closed", "completed", "2026-07-03T00:00:00Z"],
      ["closed", "not-planned", null],
      ["open", null, null],
    ]);
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodeIssueListJson(`[{"number":"not a number"},${issueJson({ number: 7 })}]`),
    );

    expect(batch.items.map((item) => item.number)).toEqual([7]);
    expect(batch.rawCount).toBe(2);
  });

  it("fails when GitHub answered with something that is not a list of issues", () => {
    expect(Result.isFailure(decodeIssueListJson('{"message":"Not Found"}'))).toBe(true);
  });

  it("never asks gh for the conversation, which it answers with in full", () => {
    // `--json comments` is every remark's whole body rather than a count, which is megabytes a
    // page. The search carries GitHub's own count instead.
    expect(ISSUE_LIST_JSON_FIELDS.split(",")).not.toContain("comments");
    expect(ISSUE_DETAIL_JSON_FIELDS.split(",")).toContain("body");
  });
});

describe("issue detail decoding", () => {
  it("reads the body GitHub answered with", () => {
    const detail = expectSuccess(decodeIssueDetailJson(issueJson({ body: "It 500s." })));

    expect(detail.body).toBe("It 500s.");
  });

  it("reads an issue with no body as one with an empty body", () => {
    expect(expectSuccess(decodeIssueDetailJson(issueJson({}))).body).toBe("");
  });
});

describe("created issue decoding", () => {
  it("answers with where the new issue lives", () => {
    expect(
      expectSuccess(
        decodeCreatedIssueJson('{"number":9,"html_url":"https://github.com/acme/web/issues/9"}'),
      ),
    ).toEqual({ number: 9, url: "https://github.com/acme/web/issues/9" });
  });
});

describe("issue search decoding", () => {
  it("files each row under the repository it came from, with GitHub's own comment count", () => {
    const batch = expectSuccess(
      decodeIssueSearchJson(
        searchJson([
          searchItem({
            comments: { totalCount: 12 },
            milestone: { title: "v2" },
            assignees: {
              nodes: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/julius" }],
            },
            labels: { nodes: [{ name: "bug", color: "d73a4a" }, null] },
          }),
          searchItem({
            number: 9,
            repository: { nameWithOwner: "pingdotgg/t3code" },
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
          }),
        ]),
      ),
    );

    expect(batch.items.map((item) => [item.repository, item.number, item.commentCount])).toEqual([
      ["acme/web", 7, 12],
      ["pingdotgg/t3code", 9, 0],
    ]);
    expect(batch.items[0]).toMatchObject({
      // A search carries the faces the listing has none of.
      author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
      assignees: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/julius" }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: "v2",
    });
    expect(batch.items[1]?.stateReason).toBe("not-planned");
    expect(batch.rawCount).toBe(2);
    expect(batch.hasNextPage).toBe(false);
  });

  it("skips a node that is not an issue but still counts it", () => {
    const batch = expectSuccess(
      // A node GitHub answered for something other than an issue decodes as empty, and a row
      // naming no repository cannot be filed under one.
      decodeIssueSearchJson(searchJson([{}, searchItem({ repository: null }), searchItem({})])),
    );

    expect(batch.items.map((item) => item.number)).toEqual([7]);
    expect(batch.rawCount).toBe(3);
  });

  it("reports that GitHub has more rows than the slice asked for", () => {
    const batch = expectSuccess(decodeIssueSearchJson(searchJson([searchItem({})], true)));

    expect(batch.hasNextPage).toBe(true);
  });

  it("fails when GitHub answered something other than a search", () => {
    expect(Result.isFailure(decodeIssueSearchJson('{"errors":[{"message":"nope"}]}'))).toBe(true);
  });
});

describe("issue supplement decoding", () => {
  it("grants labelling and assigning to a role that has them, and to no other", () => {
    const triage = expectSuccess(
      decodeIssueSupplementJson(supplementJson({ viewerPermission: "TRIAGE" })),
    );
    const read = expectSuccess(
      decodeIssueSupplementJson(supplementJson({ viewerPermission: "READ" })),
    );

    expect(triage.viewer.canTriage).toBe(true);
    expect(read.viewer.canTriage).toBe(false);
  });

  it("grants updating where GitHub says nothing, and authorship only where it says so", () => {
    const unstated = expectSuccess(decodeIssueSupplementJson(supplementJson({})));
    const refused = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({ issue: { viewerCanUpdate: false, viewerDidAuthor: true } }),
      ),
    );

    // An absent permission is an unknown one, which the host's own refusal can still explain.
    expect(unstated.viewer).toEqual({ canTriage: false, canUpdate: true, didAuthor: false });
    expect(refused.viewer).toEqual({ canTriage: false, canUpdate: false, didAuthor: true });
  });

  it("collects the faces GitHub reports for the author and the assignees", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
            assignees: {
              nodes: [
                { login: "julius", avatarUrl: "https://avatars/julius" },
                // Nothing to file: a login with no face, and a face belonging to nobody.
                { login: "hubot" },
                { avatarUrl: "https://avatars/ghost" },
                null,
              ],
            },
            comments: { totalCount: 4 },
          },
        }),
      ),
    );

    expect([...supplement.avatarsByLogin]).toEqual([
      ["bilal", "https://avatars/bilal"],
      ["julius", "https://avatars/julius"],
    ]);
    expect(supplement.commentCount).toBe(4);
  });

  it("reads a connected change request as one that closes the issue, and a mention as one that does not", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            timelineItems: {
              nodes: [
                { __typename: "ConnectedEvent", subject: pullRequestRef(12) },
                { __typename: "CrossReferencedEvent", source: pullRequestRef(13) },
              ],
            },
          },
        }),
      ),
    );

    expect(
      supplement.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.state]),
    ).toEqual([
      [12, true, "open"],
      [13, false, "open"],
    ]);
  });

  it("drops a link that was later disconnected by hand", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            timelineItems: {
              nodes: [
                { __typename: "ConnectedEvent", subject: pullRequestRef(12) },
                {
                  __typename: "DisconnectedEvent",
                  subject: { number: 12, repository: { nameWithOwner: "ACME/Web" } },
                },
                { __typename: "ConnectedEvent", subject: pullRequestRef(13) },
              ],
            },
          },
        }),
      ),
    );

    // The same change request under a differently cased repository is the same link.
    expect(supplement.linkedPullRequests.map((link) => link.number)).toEqual([13]);
  });

  it("keeps one link for a change request seen twice, and the closing relationship of the two", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            closedByPullRequestsReferences: {
              // No `__typename`: these nodes are change requests by definition.
              nodes: [pullRequestRef(12, { __typename: undefined, state: "MERGED" })],
            },
            timelineItems: {
              nodes: [
                { __typename: "CrossReferencedEvent", source: pullRequestRef(12) },
                // A reference to another issue is a mention between issues, not the work for it.
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    __typename: "Issue",
                    number: 99,
                    repository: { nameWithOwner: "acme/web" },
                  },
                },
              ],
            },
          },
        }),
      ),
    );

    expect(
      supplement.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.state]),
    ).toEqual([[12, true, "merged"]]);
  });

  it("answers for an issue GitHub says nothing about rather than failing the read", () => {
    const supplement = expectSuccess(decodeIssueSupplementJson(supplementJson({ issue: null })));

    expect(supplement.commentCount).toBe(0);
    expect(supplement.linkedPullRequests).toEqual([]);
    expect(supplement.viewer.didAuthor).toBe(false);
  });
});

describe("viewer permission decoding", () => {
  it("reads the viewer's standing on its own", () => {
    const access = expectSuccess(
      decodeIssueViewerPermissionsJson(
        JSON.stringify({
          data: {
            repository: {
              viewerPermission: "WRITE",
              issue: { viewerCanUpdate: true, viewerDidAuthor: false },
            },
          },
        }),
      ),
    );

    expect(access).toEqual({ canTriage: true, canUpdate: true, didAuthor: false });
  });

  it("fails when GitHub answered no repository at all", () => {
    expect(Result.isFailure(decodeIssueViewerPermissionsJson('{"data":{}}'))).toBe(true);
  });
});

describe("issue activity decoding", () => {
  it("reads the conversation with the faces the listing has none of", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
          comments: {
            totalCount: 250,
            pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
            nodes: [
              {
                id: "IC_1",
                author: { login: "julius", avatarUrl: "https://avatars/julius" },
                body: "Reproduced.",
                createdAt: "2026-07-02T00:00:00Z",
                url: "https://github.com/acme/web/issues/7#issuecomment-1",
              },
              // Nothing to address a remark by, so there is no remark.
              { id: "  ", createdAt: "2026-07-02T00:00:00Z" },
              null,
            ],
          },
        }),
      ),
    );

    expect(activity.author).toEqual({
      login: "bilal",
      name: null,
      avatarUrl: "https://avatars/bilal",
    });
    expect(activity.comments.map((comment) => [comment.id, comment.body])).toEqual([
      ["IC_1", "Reproduced."],
    ]);
    // GitHub's own count, which this bounded read fell well short of.
    expect(activity.commentCount).toBe(250);
    expect(activity.nextCursor).toBe("Y3Vyc29y");
  });

  it("carries on from nowhere once GitHub says the conversation is whole", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        // GitHub sends an `endCursor` on the last page too, so the flag is what decides.
        activityJson({
          comments: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29y" },
            nodes: [],
          },
        }),
      ),
    );

    expect(activity.nextCursor).toBe(null);
  });

  it("maps every timeline event GitHub reports onto what happened", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          timeline: [
            timelineEvent("ClosedEvent"),
            timelineEvent("ReopenedEvent"),
            timelineEvent("LabeledEvent", { label: { name: "bug" } }),
            timelineEvent("UnlabeledEvent", { label: { name: "bug" } }),
            timelineEvent("AssignedEvent", { assignee: { login: "julius" } }),
            timelineEvent("UnassignedEvent", { assignee: { login: "julius" } }),
            timelineEvent("RenamedTitleEvent", { currentTitle: "A better title" }),
            timelineEvent("MilestonedEvent", { milestoneTitle: "v2" }),
            timelineEvent("LockedEvent"),
            timelineEvent("UnlockedEvent"),
            timelineEvent("CrossReferencedEvent", {
              source: {
                __typename: "PullRequest",
                number: 12,
                repository: { nameWithOwner: "acme/web" },
              },
            }),
          ],
        }),
      ),
    );

    expect(activity.events.map((event) => [event.kind, event.detail])).toEqual([
      ["closed", null],
      ["reopened", null],
      ["labeled", "bug"],
      ["unlabeled", "bug"],
      ["assigned", "julius"],
      ["unassigned", "julius"],
      ["renamed", "A better title"],
      ["milestoned", "v2"],
      ["locked", null],
      ["unlocked", null],
      ["referenced", "acme/web#12"],
    ]);
    expect(activity.events[0]?.actor).toEqual({
      login: "julius",
      name: null,
      avatarUrl: "https://avatars/julius",
    });
  });

  it("drops an event kind it has no words for rather than guessing at one", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          timeline: [
            timelineEvent("TransferredEvent"),
            // Nothing to file a change under, and nothing to say when it happened.
            timelineEvent("ClosedEvent", { id: null }),
            timelineEvent("ClosedEvent", { createdAt: null }),
            timelineEvent("ClosedEvent", { id: "CE_kept", actor: null }),
          ],
        }),
      ),
    );

    expect(activity.events.map((event) => [event.id, event.actor])).toEqual([["CE_kept", null]]);
  });

  it("answers for an issue that is not there rather than failing the read", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson('{"data":{"repository":{"issue":null}}}'),
    );

    expect(activity).toMatchObject({
      author: null,
      comments: [],
      commentCount: 0,
      nextCursor: null,
      events: [],
    });
  });
});

describe("issue comment page decoding", () => {
  it("reads the rest of a conversation in the shape the first page delivered it", () => {
    const page = expectSuccess(
      decodeIssueCommentsJson(
        JSON.stringify({
          data: {
            repository: {
              issue: {
                comments: {
                  totalCount: 250,
                  pageInfo: { hasNextPage: true, endCursor: "bmV4dA==" },
                  nodes: [{ id: "IC_2", body: "Still broken.", createdAt: "2026-07-04T00:00:00Z" }],
                },
              },
            },
          },
        }),
      ),
    );

    expect(page.comments.map((comment) => comment.id)).toEqual(["IC_2"]);
    expect(page.nextCursor).toBe("bmV4dA==");
  });
});

describe("repository label decoding", () => {
  it("reads the labels a repository offers, and skips one it named nothing", () => {
    const labels = expectSuccess(
      decodeRepositoryLabelsJson(
        JSON.stringify([
          { name: "bug", color: "d73a4a", description: "Something is broken" },
          { name: "   " },
          { color: "ffffff" },
        ]),
      ),
    );

    expect(labels.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ]);
    // Counted before decoding, so a skipped label cannot end the walk through the pages early.
    expect(labels.rawCount).toBe(3);
  });

  it("fails when GitHub answered something that is not a list of labels", () => {
    expect(Result.isFailure(decodeRepositoryLabelsJson('{"message":"Not Found"}'))).toBe(true);
  });
});

describe("assignee candidate decoding", () => {
  it("marks whoever already has the issue, and leads with them", () => {
    const list = expectSuccess(
      decodeAssigneeCandidatesJson(
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { login: "hubot", name: "Hubot", avatarUrl: "https://avatars/hubot" },
                  { login: "julius" },
                  null,
                ],
              },
              issue: {
                assignees: {
                  // Still assigned even though GitHub no longer counts them assignable.
                  nodes: [{ login: "ghost", name: "Ghost" }, { login: "julius" }],
                },
              },
            },
          },
        }),
      ),
    );

    expect(list.candidates.map((candidate) => [candidate.id, candidate.isAssigned])).toEqual([
      ["ghost", true],
      ["julius", true],
      ["hubot", false],
    ]);
    expect(list.truncated).toBe(false);
  });

  it("says the list is not all of them when GitHub has more people to offer", () => {
    const list = expectSuccess(
      decodeAssigneeCandidatesJson(
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: { pageInfo: { hasNextPage: true }, nodes: [{ login: "hubot" }] },
              issue: null,
            },
          },
        }),
      ),
    );

    expect(list.truncated).toBe(true);
    expect(list.candidates.map((candidate) => candidate.isAssigned)).toEqual([false]);
  });
});

describe("issue template decoding", () => {
  it("reads a template's own words, and the filename it is addressed by", () => {
    const templates = expectSuccess(decodeIssueTemplatesJson(issueTemplatesJson([templateEntry()])));

    expect(templates).toEqual([
      {
        key: "bug_report.md",
        name: "Bug report",
        about: "File a bug",
        title: "Bug: ",
        body: "### Steps",
        labels: ["bug"],
        assignees: ["julius"],
      },
    ]);
  });

  it("offers a template under its filename when it names itself nothing else", () => {
    const templates = expectSuccess(
      decodeIssueTemplatesJson(
        issueTemplatesJson([
          templateEntry({
            name: null,
            about: null,
            title: null,
            body: null,
            assignees: null,
            labels: null,
          }),
        ]),
      ),
    );

    expect(templates).toEqual([
      {
        key: "bug_report.md",
        name: "bug_report.md",
        about: "",
        title: "",
        body: "",
        labels: [],
        assignees: [],
      },
    ]);
  });

  it("skips a template GitHub answered nothing readable for, and keeps the rest", () => {
    const templates = expectSuccess(
      decodeIssueTemplatesJson(
        issueTemplatesJson([
          // No filename to address it by, so there is nothing to key it under.
          { name: "No filename" },
          templateEntry({ filename: "feature_request.md" }),
        ]),
      ),
    );

    expect(templates.map((template) => template.key)).toEqual(["feature_request.md"]);
  });

  it("answers with no templates for a repository GitHub reports none for", () => {
    expect(expectSuccess(decodeIssueTemplatesJson(issueTemplatesJson(null)))).toEqual([]);
  });

  it("fails when GitHub answered something that is not a repository", () => {
    expect(Result.isFailure(decodeIssueTemplatesJson('{"message":"Not Found"}'))).toBe(true);
  });
});

describe("issue template config decoding", () => {
  it("reads a config file's own settings for the chooser", () => {
    const config = decodeIssueTemplateConfigYaml(
      `blank_issues_enabled: false
contact_links:
  - name: Community support
    url: https://example.com/discuss
    about: Ask the community
`,
    );

    expect(config).toEqual({
      blankIssuesEnabled: false,
      contactLinks: [
        { name: "Community support", url: "https://example.com/discuss", about: "Ask the community" },
      ],
    });
  });

  it("answers with GitHub's own defaults for a config file that will not parse", () => {
    expect(decodeIssueTemplateConfigYaml("blank_issues_enabled: [not: closed")).toEqual(
      DEFAULT_ISSUE_TEMPLATE_CONFIG,
    );
  });

  it("answers with GitHub's own defaults for a file with nothing to configure", () => {
    // Absent, and parsed to a scalar or a list rather than to the mapping the file is meant to be.
    expect(decodeIssueTemplateConfigYaml("")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
    expect(decodeIssueTemplateConfigYaml("just some text")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
    expect(decodeIssueTemplateConfigYaml("- one\n- two\n")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
  });

  it("skips a contact link GitHub cannot open, and keeps the others", () => {
    const config = decodeIssueTemplateConfigYaml(
      `contact_links:
  - name: No URL
    about: Missing what it points to
  - name: Blank URL
    url: "   "
  - name: Community support
    url: https://example.com/discuss
`,
    );

    expect(config.contactLinks).toEqual([
      { name: "Community support", url: "https://example.com/discuss", about: "" },
    ]);
  });
});

describe("issue write bodies", () => {
  it("writes only the fields the edit carried, so a rename cannot blank a body", () => {
    expect(buildIssueWriteJson({ title: "A better title" })).toBe('{"title":"A better title"}');
  });

  it("writes an empty set, which is how the whole set is taken off", () => {
    expect(buildIssueWriteJson({ labels: [], assignees: [] })).toBe('{"labels":[],"assignees":[]}');
  });

  it("keeps a body that reads as JSON as text", () => {
    expect(buildIssueWriteJson({ body: "true" })).toBe('{"body":"true"}');
  });

  it("carries the document and the reader's own words in one request body", () => {
    const raw = encodeGraphQlRequestJson({
      query: "query($q: String!) { search(query: $q) { nodes { __typename } } }",
      variables: { q: 'is:issue "a b"' },
    });

    expect(JSON.parse(raw)).toEqual({
      query: "query($q: String!) { search(query: $q) { nodes { __typename } } }",
      variables: { q: 'is:issue "a b"' },
    });
  });
});

describe("issue search document", () => {
  it("asks GitHub's issue index for issues, so a pull request cannot arrive as one", () => {
    const query = issueSearchGraphQlQuery(10);

    // Both halves are needed: the index holds pull requests too, and only the fragment says
    // which of the two a node has to be.
    expect(query).toContain("type: ISSUE");
    expect(query).toContain("... on Issue");
    expect(query).toContain("first: 10");
  });

  it("clamps the page to what GitHub's search will serve", () => {
    expect(issueSearchGraphQlQuery(500)).toContain(`first: ${ISSUE_SEARCH_MAX_ROWS}`);
    expect(issueSearchGraphQlQuery(0)).toContain("first: 1");
  });
});
