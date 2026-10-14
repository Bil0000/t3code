import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);

const ISSUE = {
  iid: 42,
  title: "Composer loses focus",
  web_url: "https://gitlab.com/acme/web/-/issues/42",
  description: "Typing in the composer drops focus after a paste.",
  author: { id: 1, username: "octocat", name: "Octo Cat", avatar_url: "https://avatars/octocat" },
  state: "closed",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: "2026-07-03T00:00:00Z",
  assignees: [{ id: 2, username: "theo", name: null }],
  labels: ["bug", " "],
  user_notes_count: 3,
};

/** Every endpoint the detail read touches, answered by the path `glab api` is given. */
function answer(path: string): string {
  if (path === "user") return encode({ username: "julius" });
  if (path === "projects/acme%2Fweb/issues/42") return encode(ISSUE);
  if (path.startsWith("projects/acme%2Fweb/issues/42/resource_label_events")) {
    return encode([
      {
        id: 3,
        action: "add",
        created_at: "2026-07-01T01:00:00Z",
        user: { username: "theo" },
        label: { name: "bug" },
      },
    ]);
  }
  if (path.startsWith("projects/acme%2Fweb/issues/42/closed_by")) {
    return encode([
      {
        iid: 50,
        title: "fix(web): keep composer focus",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/50",
        state: "merged",
        references: { full: "acme/web!50" },
      },
    ]);
  }
  if (path.startsWith("projects/acme%2Fweb/issues/42/related_merge_requests")) {
    return encode([
      {
        iid: 50,
        title: "fix(web): keep composer focus",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/50",
        state: "merged",
        references: { full: "acme/web!50" },
      },
      {
        iid: 51,
        title: "chore: mention",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/51",
        state: "opened",
        draft: true,
        references: { full: "acme/web!51" },
      },
    ]);
  }
  if (path === "graphql") {
    return encode({
      data: {
        currentUser: { username: "julius" },
        project: {
          mergeRequest: {
            awardEmoji: { nodes: [{ name: "eyes", user: { username: "theo" } }] },
            notes: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "gid://gitlab/Note/7",
                  body: "Repro attached.",
                  author: { username: "julius" },
                  createdAt: "2026-07-02T00:00:00Z",
                  awardEmoji: {
                    nodes: [
                      { name: "thumbsup", user: { username: "julius" } },
                      { name: "thumbsup", user: { username: "theo" } },
                    ],
                  },
                },
                {
                  id: "gid://gitlab/Note/8",
                  body: "closed",
                  author: { username: "theo" },
                  createdAt: "2026-07-03T00:00:00Z",
                  system: true,
                },
                {
                  id: "gid://gitlab/Note/9",
                  body: "added ~7 label",
                  author: { username: "theo" },
                  createdAt: "2026-07-03T00:00:00Z",
                  system: true,
                },
              ],
            },
          },
        },
      },
    });
  }
  throw new Error(`unexpected path ${path}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>, stdin?: string) => string) {
  return GitLabIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: ({ args, stdin }) =>
          Effect.succeed(TestSourceControlHost.processOutput(onExecute(args, stdin))),
      }),
    ),
  );
}

describe("GitLabIssueTracker", () => {
  it.effect.each([true, false])(
    "keeps native older-note edit permission %s without a viewer",
    (canEdit) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args, stdin) => {
          paths.push(args[1]!);
          expect(stdin).toContain("adminNote");
          return encode({
            data: {
              project: {
                mergeRequest: {
                  notes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://gitlab/Note/7",
                        body: "Older",
                        author: { username: "other" },
                        createdAt: "2026-07-02T00:00:00Z",
                        userPermissions: { adminNote: canEdit },
                      },
                    ],
                  },
                },
              },
            },
          });
        });
        const page = yield* api.getComments({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          key: "42",
          cursor: "older",
        });
        expect(page.comments[0]?.canEdit).toBe(canEdit);
        expect(paths).toEqual(["graphql"]);
      }),
  );

  it.effect.each([
    { state: "open", event: "reopen" },
    { state: "closed", event: "close" },
    { state: "native-unknown", event: null },
  ])("writes only supported GitLab state tokens: $state", ({ state, event }) =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const api = yield* tracker((args, stdin) => {
        expect(args).toContain("PUT");
        expect(args[1]).toBe("projects/acme%2Fweb/issues/42");
        writes.push(JSON.parse(stdin!));
        return "{}";
      });
      const result = yield* Effect.result(
        api.setState!({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          key: "42",
          state,
        }),
      );
      expect(Result.isSuccess(result)).toBe(event !== null);
      expect(writes).toEqual(event === null ? [] : [{ state_event: event }]);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "IssueTrackerError",
          operation: "setState",
        });
    }),
  );

  it.effect.each([true, false])(
    "uses the note's native edit permission %s on the selected host",
    (canEdit) =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const api = yield* tracker((args, stdin) => {
          expect(args[args.indexOf("--hostname") + 1]).toBe("gitlab.internal:8443");
          if (args[1] === "graphql")
            return encode({ data: { note: { userPermissions: { adminNote: canEdit } } } });
          if (args.includes("PUT")) {
            writes.push(stdin!);
            return "{}";
          }
          return encode({ id: 7, noteable_iid: 42, noteable_type: "Issue", system: false });
        });
        const result = yield* Effect.result(
          api.editComment!({
            cwd: "/w",
            host: "gitlab.internal:8443",
            scope: "acme/web",
            key: "42",
            commentId: "7",
            body: "Updated",
          }),
        );
        expect(Result.isSuccess(result)).toBe(canEdit);
        expect(writes).toEqual(canEdit ? [encode({ body: "Updated" })] : []);
      }),
  );

  it.effect("keeps native history phases when a notes page contains no history", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        const path = args[1]!;
        if (path.includes("/notes?"))
          return encode([
            { id: 1, created_at: "2026-07-01T00:00:00Z", system: false, body: "Comment" },
          ]);
        if (path.includes("resource_label_events"))
          return encode([
            { id: 2, created_at: "2026-07-01T00:00:00Z", action: "add", label: { name: "bug" } },
          ]);
        return encode([{ id: 3, created_at: "2026-07-01T00:00:00Z", state: "closed" }]);
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42", limit: 2 };
      const notes = yield* api.getHistory!(target);
      expect(notes).toEqual({ items: [], nextCursor: "labels:1" });
      const labels = yield* api.getHistory!({ ...target, cursor: notes.nextCursor! });
      expect(labels).toMatchObject({
        items: [{ kind: "labeled", detail: "bug" }],
        nextCursor: "states:1",
      });
      expect(yield* api.getHistory!({ ...target, cursor: labels.nextCursor! })).toMatchObject({
        items: [{ kind: "closed" }],
        nextCursor: null,
      });
    }),
  );

  it.effect(
    "passes native list sorting and empty workflow filters without broadening the scope",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args) => {
          paths.push(args[1]!);
          return "[]";
        });
        const input = {
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          state: "all" as const,
          involvement: "all" as const,
          viewer: "julius",
          limit: 5,
          sort: "created" as const,
          order: "asc" as const,
        };
        yield* api.listIssues(input);
        expect(paths[0]).toContain("order_by=created_at&sort=asc");
        expect(yield* api.listIssues({ ...input, stateCategories: ["canceled"] })).toEqual({
          items: [],
          nextCursor: null,
        });
        expect(paths).toHaveLength(1);
      }),
  );

  it.effect("clears all assignees with GitLab's native zero sentinel", () =>
    Effect.gen(function* () {
      let body: string | undefined;
      const api = yield* tracker((_args, stdin) => {
        body = stdin;
        return "{}";
      });
      yield* api.update!({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
        assignees: [],
      });
      expect(JSON.parse(body!)).toEqual({ assignee_ids: [0] });
    }),
  );

  it.effect("pins every issue read and write to the selected GitLab host", () =>
    Effect.gen(function* () {
      const requests: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        requests.push(args);
        return args.includes("PUT") ? "{}" : answer(args[1]!);
      });
      const target = { cwd: "/w", host: "gitlab.acme.test", scope: "acme/web", key: "42" };
      yield* api.getIssue(target);
      yield* api.update!({ ...target, title: "Updated title" });
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every((args) => args[args.indexOf("--hostname") + 1] === target.host)).toBe(
        true,
      );
    }),
  );

  it.effect("refuses unsupported mention filtering before making a native request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "[]";
      });
      const error = yield* Effect.flip(
        api.listIssues({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          state: "all",
          involvement: "mentioned",
          viewer: "julius",
          limit: 20,
        }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
      expect(api.capabilities.involvements).toEqual(["all", "assigned", "authored"]);
    }),
  );

  it.effect("keeps numeric actor IDs when current and candidate assignees are sent back", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let sentBody: string | undefined;
      const api = yield* tracker((args, stdin) => {
        paths.push(args[1]!);
        if (args.includes("PUT")) {
          sentBody = stdin;
          return encode(ISSUE);
        }
        if (args[1]?.startsWith("projects/acme%2Fweb/members")) {
          return encode([{ id: 6, username: "alice" }]);
        }
        if (args[1]?.startsWith("projects/acme%2Fweb/labels")) return "[]";
        return answer(args[1]!);
      });
      const context = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(context);
      const candidates = yield* api.listCandidates!(context);
      expect(issue.author?.id).toBe("1");
      expect(issue.assignees[0]?.id).toBe("2");
      yield* api.update!({
        ...context,
        assignees: [...issue.assignees.map((actor) => actor.id!), candidates.assignees[0]!.id],
      });
      expect(paths.at(-1)).toBe("projects/acme%2Fweb/issues/42");
      expect(sentBody).toBe(encode({ assignee_ids: [2, 6] }));
    }),
  );

  it.effect("removes the viewer's reaction beyond the first awards page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        const path = args[1]!;
        paths.push(path);
        if (path === "user") return encode({ username: "julius" });
        if (args.includes("DELETE")) return "{}";
        return encode(
          path.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: "thumbsup",
                user: { username: "theo" },
              }))
            : [{ id: 101, name: "thumbsup", user: { username: "julius" } }],
        );
      });
      yield* api.setReaction!({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
        subjectId: "7",
        content: "thumbs-up",
        reacted: false,
      });
      expect(paths.slice(1)).toEqual([
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji?per_page=100&page=1",
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji?per_page=100&page=2",
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji/101",
      ]);
    }),
  );

  it.effect("fails instead of claiming removal when the awards search reaches its bound", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const api = yield* tracker((args) => {
        methods.push(args.includes("DELETE") ? "DELETE" : "GET");
        return args[1] === "user"
          ? encode({ username: "julius" })
          : encode(
              Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: "eyes",
                user: { username: "theo" },
              })),
            );
      });
      const error = yield* Effect.flip(
        api.setReaction!({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          key: "42",
          content: "thumbs-up",
          reacted: false,
        }),
      );
      expect(error.reason).toBe("failed");
      expect(methods).toHaveLength(11);
      expect(methods).not.toContain("DELETE");
    }),
  );

  it.effect("loads native reactions for comments on a continuation page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let sentBody: string | undefined;
      const api = yield* tracker((args, stdin) => {
        const path = args[1]!;
        paths.push(path);
        sentBody = stdin;
        return encode({
          data: {
            currentUser: { username: "julius" },
            project: {
              mergeRequest: {
                awardEmoji: { nodes: [] },
                notes: {
                  pageInfo: { hasNextPage: true, endCursor: "native-next" },
                  nodes: [
                    {
                      id: "gid://gitlab/Note/107",
                      body: "Older page",
                      author: { id: "gid://gitlab/User/2", username: "theo" },
                      createdAt: "2026-07-02T00:00:00Z",
                      awardEmoji: {
                        pageInfo: { hasNextPage: true },
                        nodes: [
                          { name: "thumbsup", user: { username: "julius" } },
                          { name: "thumbsup", user: { username: "theo" } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      });
      const page = yield* api.getComments({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
        cursor: "native-cursor",
      });
      expect(page.comments[0]?.author?.id).toBe("2");
      expect(page.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      expect(page.comments[0]?.reactionsTruncated).toBe(true);
      expect(page.nextCursor).toBe("native-next");
      expect(paths).toEqual(["graphql"]);
      expect(sentBody).toContain('"cursor":"native-cursor"');
    }),
  );

  it.effect("marks partial detail reactions and history without reading more pages", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        const path = args[1]!;
        paths.push(path);
        if (path !== "graphql") return answer(path);
        return encode({
          data: {
            currentUser: { username: "julius" },
            project: {
              mergeRequest: {
                awardEmoji: {
                  pageInfo: { hasNextPage: true },
                  nodes: [{ name: "eyes", user: { username: "theo" } }],
                },
                notes: {
                  pageInfo: { hasNextPage: true, endCursor: "native-next" },
                  nodes: [
                    {
                      id: "gid://gitlab/Note/108",
                      body: "closed",
                      system: true,
                      author: { id: "gid://gitlab/User/2", username: "theo" },
                      createdAt: "2026-07-02T00:00:00Z",
                    },
                  ],
                },
              },
            },
          },
        });
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.reactionsTruncated).toBe(true);
      expect(issue.historyTruncated).toBe(true);
      expect(issue.commentsCursor).toBe("native-next");
      expect(issue.comments).toEqual([]);
      expect(issue.events).toContainEqual({
        id: "note-108",
        kind: "closed",
        actor: { id: "2", login: "theo", name: null, avatarUrl: null },
        createdAt: "2026-07-02T00:00:00Z",
        detail: null,
      });
      expect(paths).toHaveLength(6);
      expect(paths.filter((path) => path === "graphql")).toHaveLength(1);
      expect(paths.some((path) => path.includes("/notes"))).toBe(false);
    }),
  );

  it.effect("joins the detail's endpoints into the neutral issue shape", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => answer(args[1]!));
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "closed", name: "closed" },
        author: { login: "octocat", name: "Octo Cat" },
        assignees: [{ login: "theo" }],
        labels: [{ name: "bug", color: null }],
        commentCount: 3,
        viewer: "julius",
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
        commentsCursor: null,
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
      });
      expect(issue.comments).toEqual([
        {
          id: "7",
          author: { login: "julius", name: null, avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          editedAt: null,
          canEdit: false,
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true }],
        },
      ]);
      // System notes become events; label notes are dropped in favour of the label events.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["closed", null],
      ]);
      // A closing merge request is not repeated as a related one.
      expect(
        issue.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.isDraft]),
      ).toEqual([
        [50, true, false],
        [51, false, true],
      ]);
    }),
  );

  it.effect("marks a full native label-event page as partial before skipping unknown events", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) =>
        args[1]!.includes("resource_label_events")
          ? encode(
              Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                action: "unknown",
                created_at: "2026-07-01T00:00:00Z",
              })),
            )
          : answer(args[1]!),
      );
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.commentsCursor).toBeNull();
      expect(issue.historyTruncated).toBe(true);
      expect(issue.events).toHaveLength(1);
    }),
  );

  it.effect("pages a listing by GitLab's page number and stops on a short page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[1]!);
        return encode([ISSUE]);
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        state: "open",
        involvement: "assigned",
        viewer: "julius",
        limit: 1,
        cursor: "3",
      });
      expect(paths[0]).toBe(
        "projects/acme%2Fweb/issues?state=opened&scope=all&assignee_username=julius&order_by=updated_at&sort=desc&per_page=1&page=3",
      );
      expect(page.items[0]?.key).toBe("42");
      expect(page.nextCursor).toBe("4");
    }),
  );

  it.effect("refuses a key that names no GitLab issue without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "ENG-42" }),
      );
      expect(error.reason).toBe("not-found");
      expect(requests).toBe(0);
    }),
  );
});
