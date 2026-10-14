import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
