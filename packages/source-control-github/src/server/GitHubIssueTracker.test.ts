import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

/** A detail answer as GitHub's GraphQL API shapes it, with every section populated once. */
const DETAIL_FIXTURE = {
  data: {
    viewer: { login: "julius" },
    repository: {
      viewerPermission: "TRIAGE",
      issue: {
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: { login: "octocat", avatarUrl: "https://avatars/octocat", name: "Octo Cat" },
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        closedAt: "2026-07-03T00:00:00Z",
        comments: {
          totalCount: 3,
          pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
          nodes: [
            {
              id: "IC_1",
              author: { login: "julius", avatarUrl: null },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: { totalCount: 2, nodes: [{ login: "julius" }, { login: "theo" }] },
                },
                {
                  content: "EYES",
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] },
                },
              ],
            },
          ],
        },
        assignees: { nodes: [{ login: "theo", name: null, avatarUrl: null }] },
        labels: { nodes: [{ name: "bug", color: "d73a4a" }, null] },
        body: "Typing in the composer drops focus after a paste.",
        viewerCanUpdate: false,
        reactionGroups: [],
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 50,
              title: "fix(web): keep composer focus",
              url: "https://github.com/acme/web/pull/50",
              state: "MERGED",
              isDraft: false,
              repository: { nameWithOwner: "acme/web" },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: { login: "theo" },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: { login: "julius" },
              source: {
                __typename: "PullRequest",
                number: 50,
                title: "fix(web): keep composer focus",
                url: "https://github.com/acme/web/pull/50",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/web" },
              },
            },
            { __typename: "MentionedEvent", id: "ME_1", createdAt: "2026-07-02T02:00:00Z" },
            {
              __typename: "ClosedEvent",
              id: "CE_1",
              createdAt: "2026-07-03T00:00:00Z",
              actor: null,
            },
          ],
        },
      },
    },
  },
};
const DETAIL_RESPONSE = JSON.stringify(DETAIL_FIXTURE);

function tracker(
  graphql: (query: string, variables: unknown) => string,
  rest: (input: GitHubApi.GitHubRestInput) => GitHubApi.GitHubRestResponse = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ labels: [{ name: "bug", color: "d73a4a" }] }),
    truncated: false,
    invalidUtf8: false,
  }),
) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        graphql: ({ query, variables }) => Effect.succeed(graphql(query, variables)),
        rest: (input) => Effect.succeed(rest(input)),
      }),
    ),
  );
}

describe("GitHubIssueTracker", () => {
  it.effect.each([
    { categories: ["canceled"] as const, keys: ["8"], reason: 'reason:"not planned"' },
    { categories: ["completed"] as const, keys: ["9"], reason: "reason:completed" },
    { categories: ["completed", "canceled"] as const, keys: ["8", "9"], reason: null },
    { categories: ["unstarted", "completed"] as const, keys: ["7", "9"], reason: null },
    { categories: ["unstarted", "canceled"] as const, keys: ["7", "8"], reason: null },
  ])("filters native workflow categories $categories and keeps the native cursor", (selection) =>
    Effect.gen(function* () {
      let searches = 0;
      const api = yield* tracker((_query, variables) => {
        searches += 1;
        const query = (variables as { q: string }).q;
        if (selection.reason === null) expect(query).not.toContain("reason:");
        else expect(query).toContain(selection.reason);
        if (selection.categories.some((category) => category === "unstarted")) {
          expect(query).not.toContain("is:open");
          expect(query).not.toContain("is:closed");
        } else expect(query).toContain("is:closed");
        return JSON.stringify({
          data: {
            search: {
              nodes: [
                { ...DETAIL_FIXTURE.data.repository.issue, number: 7, state: "OPEN" },
                { ...DETAIL_FIXTURE.data.repository.issue, number: 8 },
                { ...DETAIL_FIXTURE.data.repository.issue, number: 9, stateReason: "COMPLETED" },
              ],
              pageInfo: { hasNextPage: true, endCursor: "native-next" },
            },
          },
        });
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "julius",
        stateCategories: selection.categories,
        limit: 3,
      });
      expect(page.items.map((item) => item.key)).toEqual(selection.keys);
      expect(page.nextCursor).toBe("native-next");
      expect(searches).toBe(1);
    }),
  );

  it.effect.each([true, false])(
    "keeps a created issue when attaching its parent succeeds %s",
    (linked) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker(
          () => "{}",
          (input) => {
            paths.push(input.path);
            const body = input.path.endsWith("sub_issues")
              ? linked
                ? "{}"
                : "invalid"
              : JSON.stringify({
                  id: input.method ? 1043 : 1021,
                  number: input.method ? 43 : 21,
                  title: "Issue",
                  html_url: `https://github.com/acme/web/issues/${input.method ? 43 : 21}`,
                  state: "open",
                });
            return { status: 200, headers: {}, body, truncated: false, invalidUtf8: false };
          },
        );
        expect(
          yield* api.create!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            title: "Created",
            body: "",
            labels: [],
            assignees: [],
            parentKey: "21",
          }),
        ).toMatchObject({ key: "43", parentLinked: linked });
        expect(paths).toEqual([
          "repos/acme/web/issues/21",
          "repos/acme/web/issues",
          "repos/acme/web/issues/21/sub_issues",
        ]);
      }),
  );

  it.effect.each([true, false])(
    "edits a scoped comment only when its native permission is %s",
    (canEdit) =>
      Effect.gen(function* () {
        const queries: string[] = [];
        const api = yield* tracker((query) => {
          queries.push(query);
          return JSON.stringify({
            data: {
              repository: { issue: { id: "I_42" } },
              node: { viewerCanUpdate: canEdit, issue: { id: "I_42" } },
            },
          });
        });
        const result = yield* Effect.result(
          api.editComment!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            commentId: "IC_1",
            body: "Updated",
          }),
        );
        expect(Result.isSuccess(result)).toBe(canEdit);
        expect(queries.some((query) => query.includes("updateIssueComment"))).toBe(canEdit);
      }),
  );

  it.effect("reads cross-repository hierarchy pages and attaches and removes a parent", () =>
    Effect.gen(function* () {
      const writes: GitHubApi.GitHubRestInput[] = [];
      const raw = (number: number, scope = "acme/web") => ({
        id: number + 1000,
        number,
        title: `Issue ${number}`,
        html_url: `https://github.com/${scope}/issues/${number}`,
        state: "open",
      });
      const api = yield* tracker(
        () => "{}",
        (input) => {
          if (input.method) writes.push(input);
          const body = input.path.includes("sub_issues?")
            ? [raw(42, "acme/other")]
            : input.path.endsWith("/parent")
              ? raw(21, "acme/other")
              : input.path.endsWith("/21")
                ? raw(21)
                : raw(42);
          return {
            status: 200,
            headers: input.path.includes("sub_issues?")
              ? { link: '<https://github.com/next>; rel="next"' }
              : {},
            body: JSON.stringify(body),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const hierarchy = yield* api.getHierarchy!({ ...target, limit: 1 });
      expect(hierarchy.parent).toMatchObject({ scope: "acme/other", key: "21" });
      expect(hierarchy.children).toMatchObject({
        items: [{ scope: "acme/other", key: "42" }],
        nextCursor: "2",
      });
      yield* api.setParent!({ ...target, parentKey: "21" });
      yield* api.setParent!({ ...target, parentKey: null });
      expect(writes.map((input) => [input.path, input.method, input.body])).toEqual([
        [
          "repos/acme/web/issues/21/sub_issues",
          "POST",
          { sub_issue_id: 1042, replace_parent: true },
        ],
        ["repos/acme/other/issues/21/sub_issue", "DELETE", { sub_issue_id: 1042 }],
      ]);
    }),
  );

  it.effect("keeps native history continuation after comment rows and unknown events", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => "{}",
        (input) => {
          expect(input.path).toBe("repos/acme/web/issues/42/timeline?per_page=3&page=2");
          return {
            status: 200,
            headers: { link: '<https://github.com/next>; rel="next"' },
            body: JSON.stringify([
              { id: 1, event: "commented", created_at: "2026-07-01T00:00:00Z" },
              { id: 2, event: "milestoned", created_at: "2026-07-01T00:00:00Z" },
              { event: "cross-referenced", created_at: "2026-07-01T00:00:00Z" },
            ]),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      expect(
        yield* api.getHistory!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          cursor: "2",
          limit: 3,
        }),
      ).toMatchObject({
        items: [{ id: "2", kind: "updated", detail: "milestoned" }],
        nextCursor: "3",
      });
    }),
  );

  it.effect("pages closing and related pull requests separately", () =>
    Effect.gen(function* () {
      const api = yield* tracker((query, variables) => {
        expect(variables).toMatchObject({
          owner: "acme",
          name: "web",
          number: 42,
          first: 1,
          after: null,
        });
        const closing = query.includes("closedByPullRequestsReferences");
        const pr = {
          __typename: "PullRequest",
          number: 50,
          title: "Fix",
          url: "https://github.com/acme/other/pull/50",
          state: "MERGED",
          repository: { nameWithOwner: "acme/other" },
        };
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                [closing ? "closedByPullRequestsReferences" : "timelineItems"]: {
                  nodes: closing ? [pr] : [{ source: pr }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      });
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42", limit: 1 };
      const closing = yield* api.getLinkedPullRequests!(target);
      expect(closing).toMatchObject({
        items: [{ repository: "acme/other", closesIssue: true }],
        nextCursor: "related:",
      });
      expect(
        yield* api.getLinkedPullRequests!({ ...target, cursor: closing.nextCursor! }),
      ).toMatchObject({ items: [{ closesIssue: false }], nextCursor: null });
    }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "refuses success when GitHub omits the requested %s update",
    (field) =>
      Effect.gen(function* () {
        const requests: GitHubApi.GitHubRestInput[] = [];
        const api = yield* tracker(
          () => DETAIL_RESPONSE,
          (input) => {
            requests.push(input);
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({ labels: [], assignees: [] }),
              truncated: false,
              invalidUtf8: false,
            };
          },
        );
        const error = yield* api.update!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          [field]: ["expected"],
        }).pipe(Effect.flip);
        expect(error.detail).toBe(`GitHub did not save the requested ${field}.`);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect("keeps a created issue and warns when GitHub skips metadata", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        () => ({
          status: 201,
          headers: {},
          body: JSON.stringify({
            number: 43,
            html_url: "https://github.com/acme/web/issues/43",
            labels: [],
            assignees: [],
          }),
          truncated: false,
          invalidUtf8: false,
        }),
      );
      const result = yield* api.create!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        title: "Created issue",
        body: "",
        labels: ["bug"],
        assignees: ["alice"],
      });
      expect(result.key).toBe("43");
      expect(result.warnings).toEqual([
        "The issue was created, but GitHub did not save the requested labels.",
        "The issue was created, but GitHub did not save the requested assignees.",
      ]);
    }),
  );

  it.effect.each([
    ["disables blank issues with a plain false value", "blank_issues_enabled: false\n", false],
    [
      "disables blank issues with a false value and a comment",
      "blank_issues_enabled: false # require a template\n",
      false,
    ],
    [
      "enables blank issues with a true value and a comment",
      "blank_issues_enabled: true # allow blank issues\n",
      true,
    ],
    ["enables blank issues when the config has no setting", "contact_links: []\n", true],
    ["ignores a nested blank issue setting", "other:\n  blank_issues_enabled: false\n", true],
    ["enables blank issues when the config is invalid", "blank_issues_enabled: [\n", true],
  ] as const)("%s", ([, config, blankIssuesEnabled]) =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => JSON.stringify({ data: { repository: { issueTemplates: [] } } }),
        (input) => {
          expect(input.path).toBe("repos/acme/web/contents/.github/ISSUE_TEMPLATE/config.yml");
          expect(input.accept).toBe("application/vnd.github.raw");
          return {
            status: 200,
            headers: {},
            body: config,
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" }),
      ).toEqual({ templates: [], blankIssuesEnabled });
    }),
  );

  it.effect("enables blank issues when the template config is missing", () =>
    Effect.gen(function* () {
      const api = yield* GitHubIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            graphql: () =>
              Effect.succeed(JSON.stringify({ data: { repository: { issueTemplates: [] } } })),
            rest: () =>
              Effect.fail(
                new GitHubApi.GitHubApiNotFoundError({
                  host: "github.com",
                  operation: "listTemplateConfig",
                }),
              ),
          }),
        ),
      );
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" }),
      ).toEqual({ templates: [], blankIssuesEnabled: true });
    }),
  );

  it.effect("refuses reactions on a comment outside the selected issue", () =>
    Effect.gen(function* () {
      for (const reacted of [true, false]) {
        const queries: string[] = [];
        const api = yield* tracker((query, variables) => {
          queries.push(query);
          expect(variables).toEqual({
            owner: "acme",
            name: "web",
            number: 42,
            commentId: "IC_foreign",
          });
          return JSON.stringify({
            data: {
              repository: { issue: { id: "I_selected" } },
              node: { issue: { id: "I_foreign" } },
            },
          });
        });
        const error = yield* Effect.flip(
          api.setReaction!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            subjectId: "IC_foreign",
            content: "thumbs-up",
            reacted,
          }),
        );
        expect(error.detail).toBe("The comment does not belong to the selected issue.");
        expect(queries).toHaveLength(1);
        expect(queries[0]).not.toContain("mutation");
      }
    }),
  );

  it.effect("keeps every native issue label when an edit replaces the label set", () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 121 }, (_, index) => ({
        name: `label-${index}`,
        color: "abc123",
      }));
      const requests: GitHubApi.GitHubRestInput[] = [];
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        (input) => {
          requests.push(input);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ labels }),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const context = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(context);
      expect(issue.labels).toEqual(labels);
      yield* api.getViewerPermissions(context);
      yield* api.update!({ ...context, labels: issue.labels.map((label) => label.name) });
      expect(requests.map((request) => [request.method ?? "GET", request.path])).toEqual([
        ["GET", "repos/acme/web/issues/42"],
        ["PATCH", "repos/acme/web/issues/42"],
      ]);
      expect(requests[1]?.body).toEqual({ labels: labels.map((label) => label.name) });
    }),
  );

  it.effect("refuses an incomplete native label response", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        () => ({
          status: 200,
          headers: {},
          body: '{"labels":[]}',
          truncated: true,
          invalidUtf8: false,
        }),
      );
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "42" }),
      );
      expect(error.reason).toBe("failed");
    }),
  );

  it.effect("maps a detail read to the neutral issue shape", () =>
    Effect.gen(function* () {
      let seen: unknown;
      let sentQuery = "";
      const api = yield* tracker((query, variables) => {
        seen = variables;
        sentQuery = query;
        return DETAIL_RESPONSE;
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(seen).toEqual({ owner: "acme", name: "web", number: 42 });
      // GitHub rejects a query that selects one field twice with different arguments.
      expect(sentQuery.match(/\bcomments\b/g)).toHaveLength(1);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        title: "Composer loses focus",
        state: { category: "closed", name: "closed", closeReason: "not-planned" },
        author: { login: "octocat", name: "Octo Cat", avatarUrl: "https://avatars/octocat" },
        assignees: [{ login: "theo" }],
        labels: [{ name: "bug", color: "d73a4a" }],
        commentCount: 3,
        viewer: "julius",
        // Triage may label and assign; `viewerCanUpdate: false` withholds state and edits.
        viewerPermissions: {
          setState: false,
          edit: false,
          labels: true,
          assignees: true,
          comment: true,
        },
        commentsCursor: "Y3Vyc29y",
        historyTruncated: false,
      });
      // The viewer is left out of `actors` and shown as "You"; an empty group is dropped.
      expect(issue.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      // The closing reference wins over the cross-reference sighting of the same pull request.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://github.com/acme/web/pull/50",
          state: "merged",
          isDraft: false,
          closesIssue: true,
        },
      ]);
      // An event kind this page has no vocabulary for is dropped rather than guessed at.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "acme/web#50"],
        ["closed", null],
      ]);
    }),
  );

  it.effect("reports whether a capped timeline has older events", () =>
    Effect.gen(function* () {
      for (const hasPreviousPage of [true, false]) {
        const queries: string[] = [];
        const api = yield* tracker((query) => {
          queries.push(query);
          return JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  timelineItems: {
                    pageInfo: { hasPreviousPage },
                    nodes: Array.from({ length: 100 }, (_, index) => ({
                      __typename: "ClosedEvent",
                      id: `CE_${index}`,
                      createdAt: "2026-07-03T00:00:00Z",
                      actor: null,
                    })),
                  },
                },
              },
            },
          });
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.historyTruncated).toBe(hasPreviousPage);
        expect(issue.events).toHaveLength(100);
        expect(queries).toHaveLength(1);
        expect(queries[0]).toMatch(
          /timelineItems\(last: 100,[^)]*\)\s*\{\s*pageInfo\s*\{\s*hasPreviousPage\s*\}/,
        );
      }
    }),
  );

  it.effect("refuses a key that names no GitHub issue number without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return DETAIL_RESPONSE;
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "ENG-42" }),
      );
      expect(error.reason).toBe("not-found");
      expect(requests).toBe(0);
    }),
  );
});
