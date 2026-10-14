import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);
const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

const ISSUE = {
  number: 42,
  title: "Composer loses focus",
  body: "Typing drops focus.",
  html_url: "https://forgejo.test:3000/acme/web/issues/42",
  user: { login: "octocat", full_name: "Octo Cat", avatar_url: "" },
  state: "open",
  created_at: "2026-07-01T00:00:00+02:00",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: null,
  assignees: [{ login: "theo" }],
  labels: [{ id: 3, name: "bug", color: "d73a4a" }],
  comments: 1,
  is_locked: true,
};

/** Every endpoint the detail read touches, answered by path; stderr carries the `Link` header. */
function answer(path: string): { readonly stdout: string; readonly stderr?: string } {
  const [route] = path.split("?");
  switch (route) {
    case "user":
      return { stdout: encode({ login: "julius" }) };
    case "repos/acme/web":
      return {
        stdout: encode({ full_name: "acme/web", permissions: { push: false, admin: false } }),
      };
    case "repos/acme/web/issues/42":
      return { stdout: encode(ISSUE) };
    case "repos/acme/web/issues/42/timeline":
      return {
        stdout: encode([
          {
            id: 1,
            type: "label",
            body: "1",
            user: { login: "theo" },
            created_at: "2026-07-01T01:00:00Z",
            label: { id: 3, name: "bug" },
          },
          {
            id: 2,
            type: "comment",
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          },
          {
            id: 3,
            type: "pull_ref",
            user: { login: "theo" },
            created_at: "2026-07-02T01:00:00Z",
            ref_issue: {
              number: 50,
              html_url: "https://forgejo.test:3000/acme/web/pulls/50",
              pull_request: { merged: false },
            },
          },
          { id: 4, type: "milestone", user: { login: "theo" }, created_at: "2026-07-02T02:00:00Z" },
        ]),
      };
    case "repos/acme/web/issues/42/reactions":
      return { stdout: encode([{ content: "eyes", user: { login: "theo" } }]) };
    case "repos/acme/web/issues/42/comments":
      return {
        stdout: encode([
          {
            id: 7,
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
            html_url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          },
        ]),
        stderr:
          'HTTP/1.1 200\nlink: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/comments?page=2>; rel="next"\n',
      };
    case "repos/acme/web/issues/comments/7/reactions":
      return {
        stdout: encode([
          { content: "+1", user: { login: "julius" } },
          { content: "+1", user: { login: "theo" } },
        ]),
      };
    case "repos/acme/web/pulls/50":
      return {
        stdout: encode({
          number: 50,
          title: "fix(web): keep composer focus",
          html_url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          merged: false,
          draft: true,
        }),
      };
    default:
      throw new Error(`unexpected path ${path}`);
  }
}

function tracker(
  onApi: (input: ForgejoCli.ForgejoApiInput) =>
    | {
        readonly stdout: string;
        readonly stderr?: string;
      }
    | ForgejoCli.ForgejoCliError,
) {
  return ForgejoIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const result = onApi(input);
          if (isForgejoCliError(result)) return Effect.fail(result);
          const { stdout, stderr } = result;
          return Effect.succeed(
            TestSourceControlHost.processOutput(stdout, { stderr: stderr ?? "" }),
          );
        },
      }),
    ),
  );
}

describe("ForgejoIssueTracker", () => {
  it.effect("joins the issue, timeline and conversation into the neutral issue shape", () =>
    Effect.gen(function* () {
      const hosts = new Set<string | undefined>();
      const api = yield* tracker((input) => {
        hosts.add(input.host);
        return answer(input.path);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      // The custom host and port reach the CLI, which resolves the login for them.
      expect([...hosts]).toEqual(["forgejo.test:3000"]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "open", name: "open" },
        author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
        createdAt: "2026-06-30T22:00:00.000Z",
        labels: [{ name: "bug", color: "d73a4a" }],
        viewer: "julius",
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
        commentsCursor: "2",
      });
      expect(issue.comments).toEqual([
        {
          id: "7",
          author: { login: "julius", name: null, avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00.000Z",
          url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          reactions: [{ content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true }],
        },
      ]);
      // Comments and milestones on the timeline are not events in the shared vocabulary.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "#50"],
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          isDraft: true,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect("keeps unknown issue-unit controls available without using code push permission", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => answer(input.path));
      expect(
        yield* api.getViewerPermissions({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        }),
      ).toEqual({ setState: true, comment: true, edit: true, labels: true, assignees: true });
    }),
  );

  it.effect("reads only the repository to determine issue permissions", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return answer(input.path);
      });
      yield* api.getViewerPermissions({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(paths).toEqual(["repos/acme/web"]);
    }),
  );

  it.effect.each([
    { name: "a non-admin issue writer with code read access", denied: false },
    { name: "a reader refused by native issue permissions", denied: true },
  ])("lets the native API decide locked commenting for $name", ({ denied }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const detail = "Native issue permissions denied this comment.";
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method === "POST")
          return denied
            ? new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/w",
                reason: "forbidden",
                httpStatus: 403,
                detail,
              })
            : {
                stdout: encode({
                  id: 8,
                  body: "A comment",
                  user: { login: "julius" },
                  created_at: "2026-07-04T00:00:00Z",
                }),
                stderr: "HTTP/1.1 201 Created",
              };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      expect((yield* api.getViewerPermissions(target)).comment).toBe(true);
      const write = api.comment!({ ...target, body: "A comment" });
      if (denied) expect(yield* Effect.flip(write)).toMatchObject({ reason: "failed", detail });
      else yield* write;
      expect(requests).toHaveLength(2);
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        {
          cwd: "/w",
          host: "forgejo.test:3000",
          repository: "acme/web",
          path: "repos/acme/web/issues/42/comments",
          method: "POST",
          body: { body: "A comment" },
        },
      ]);
    }),
  );

  it.effect.each([{ archived: true }, { has_issues: false }])(
    "disables issue controls for native repository restriction %s",
    (restriction) =>
      Effect.gen(function* () {
        const api = yield* tracker((input) =>
          input.path === "repos/acme/web"
            ? {
                stdout: encode({
                  full_name: "acme/web",
                  permissions: { push: true, admin: false },
                  ...restriction,
                }),
              }
            : answer(input.path),
        );
        expect(
          yield* api.getViewerPermissions({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
          }),
        ).toEqual({
          setState: false,
          comment: false,
          edit: false,
          labels: false,
          assignees: false,
        });
      }),
  );

  it.effect(
    "resolves linked pull requests by native repository and number on the configured host",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const references = [
          ["acme/web", 50],
          ["other/repo", 50],
          ["other/repo", 50],
          ["foreign/repo", 60],
        ] as const;
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const route = input.path.split("?")[0]!;
          if (route === "repos/acme/web/issues/42/timeline")
            return {
              stdout: encode(
                references.map(([repository, number], index) => ({
                  id: index + 1,
                  type: "pull_ref",
                  created_at: "2026-07-02T00:00:00Z",
                  ref_issue: {
                    number,
                    html_url: `https://${repository === "foreign/repo" ? "other.test" : "forgejo.test:3000"}/${repository}/pulls/${number}`,
                    pull_request: { merged: false },
                  },
                })),
              ),
            };
          if (route === "repos/other/repo/pulls/50")
            return {
              stdout: encode({
                number: 50,
                title: "Other project fix",
                html_url: "https://forgejo.test:3000/other/repo/pulls/50",
                state: "closed",
                merged: true,
              }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(
          issue.linkedPullRequests.map((pull) => [pull.repository, pull.number, pull.state]),
        ).toEqual([
          ["acme/web", 50, "open"],
          ["other/repo", 50, "merged"],
        ]);
        expect(paths.filter((path) => path.includes("/pulls/"))).toEqual([
          "repos/acme/web/pulls/50",
          "repos/other/repo/pulls/50",
        ]);
      }),
  );

  it.effect("marks native timeline continuation without walking its next page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const result = answer(input.path);
        return input.path.includes("/timeline")
          ? {
              ...result,
              stderr:
                'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=2>; rel="next"',
            }
          : result;
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.historyTruncated).toBe(true);
      expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "refuses unresolved label names before %s writes",
    (operation) =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const api = yield* tracker((input) => {
          if (input.method) {
            writes.push(input.path);
            return { stdout: encode(ISSUE) };
          }
          if (input.path.startsWith("repos/acme/web/labels"))
            return { stdout: encode([{ id: 12, name: "bug" }]) };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const error = yield* Effect.flip(
          operation === "create"
            ? api.create!({
                ...target,
                title: "New issue",
                body: "",
                labels: ["12", "later"],
                assignees: [],
              })
            : api.update!({ ...target, title: "Changed title", labels: ["12", "later"] }),
        );
        expect(error.detail).toContain("label");
        expect(writes).toEqual([]);
      }),
  );

  it.effect("maps a numeric native label name to its actual mutation ID", () =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.path.startsWith("repos/acme/web/labels"))
          return {
            stdout: encode([
              { id: 93, name: "12" },
              { id: 12, name: "bug" },
            ]),
          };
        if (input.method) {
          writes.push(input);
          return { stdout: encode(ISSUE) };
        }
        return answer(input.path);
      });
      yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["12"],
        assignees: [],
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({ labels: [93] });
    }),
  );

  it.effect.each([{ assignees: ["julius"] }, { assignees: [] }] as const)(
    "reports native success with ignored assignee set %s as a failed update",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return { stdout: encode(ISSUE), stderr: "HTTP/1.1 201 Created" };
        });
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            assignees,
          }),
        );
        expect(error.detail).toContain("assignees");
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ method: "PATCH", body: { assignees: [...assignees] } });
      }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "keeps the created issue and warns when native success skips selected %s",
    (field) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return input.method === "POST"
            ? {
                stdout: encode({ ...ISSUE, labels: [], assignees: [] }),
                stderr: "HTTP/1.1 201 Created",
              }
            : { stdout: encode([{ id: 3, name: "bug" }]) };
        });
        const result = yield* api.create!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          title: "New issue",
          body: "",
          labels: field === "labels" ? ["bug"] : [],
          assignees: field === "assignees" ? ["julius"] : [],
        });
        expect(result).toMatchObject({ key: "42", displayKey: "#42", url: ISSUE.html_url });
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings?.[0]).toContain(field);
        expect(requests).toHaveLength(field === "labels" ? 2 : 1);
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
          assignees: field === "assignees" ? ["julius"] : [],
        });
      }),
  );

  it.effect("returns no create warnings when native labels and assignees match", () =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return input.method === "POST"
          ? { stdout: encode({ ...ISSUE, assignees: [{ login: "theo" }, { login: "julius" }] }) }
          : { stdout: encode([{ id: 3, name: "bug" }]) };
      });
      const result = yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["bug"],
        assignees: ["julius", "THEO"],
      });
      expect(result.warnings ?? []).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
        assignees: ["julius", "THEO"],
      });
    }),
  );

  it.effect.each([{ assignees: ["julius", "THEO"] }, { assignees: [] }] as const)(
    "accepts an applied native assignee set %s independent of order and username case",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return {
            stdout: encode({
              ...ISSUE,
              assignees: assignees.length ? [{ login: "theo" }, { login: "julius" }] : [],
            }),
          };
        });
        yield* api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          assignees,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.body).toMatchObject({ assignees: [...assignees] });
      }),
  );

  it.effect.each([
    undefined,
    'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=1>; rel="first"',
  ])(
    "marks a filtered native timeline page as partial unless its Link header proves completion %s",
    (stderr) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.includes("/timeline"))
            return {
              stdout: encode(
                Array.from({ length: 49 }, (_, index) => ({
                  id: index + 1,
                  type: "label",
                  label: { id: 3, name: "bug" },
                  created_at: "2026-07-01T00:00:00Z",
                })),
              ),
              ...(stderr === undefined ? {} : { stderr }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.historyTruncated).toBe(stderr === undefined);
        expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
      }),
  );

  it.effect("lists issues by page and leaves pull requests out of the rows", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode([
            ISSUE,
            ...Array.from({ length: 49 }, (_, index) => ({
              ...ISSUE,
              number: 43 + index,
              pull_request: { merged: false },
            })),
          ]),
        };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "authored",
        viewer: "julius",
        limit: 50,
        cursor: "2",
      });
      expect(paths).toEqual([
        "repos/acme/web/issues?type=issues&state=open&sort=recentupdate&created_by=julius&limit=50&page=2",
      ]);
      expect(page.items.map((item) => item.key)).toEqual(["42"]);
      // No `Link` header at all means the server may still have more; a full page carries on.
      expect(page.nextCursor).toBe("3");
    }),
  );

  it.effect("slices an unpaged Gitea comments response without repeating the first comments", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 51 }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      }));
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const route = input.path.split("?")[0]!;
        if (route === "repos/acme/web/issues/42/comments")
          return { stdout: encode(comments), stderr: "X-Total-Count: 51" };
        if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      expect(first.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: 50 }, (_, index) => String(index + 1)),
      );
      expect(first.commentsCursor).toBe("offset:50");
      const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
      expect(second.comments.map((comment) => comment.id)).toEqual(["51"]);
      expect(second.nextCursor).toBeNull();
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(2);
      expect(paths.filter((path) => path.endsWith("/comments/51/reactions"))).toHaveLength(1);
    }),
  );

  it.effect(
    "continues headerless issue pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const issues = Array.from({ length: 50 }, (_, index) => ({ ...ISSUE, number: index + 1 }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
          return { stdout: encode(issues.slice((page - 1) * 20, page * 20)) };
        });
        let cursor: string | undefined;
        const keys: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.listIssues({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            state: "open",
            involvement: "all",
            viewer: "julius",
            limit: 50,
            cursor,
          });
          keys.push(...result.items.map((issue) => issue.key));
          expect(result.nextCursor).toBe(page === 4 ? null : String(page + 1));
          expect(paths).toHaveLength(page);
          cursor = result.nextCursor ?? undefined;
        }
        expect(keys).toEqual(issues.map((issue) => String(issue.number)));
      }),
  );

  it.effect(
    "continues headerless comment pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const comments = Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const [route, query] = input.path.split("?");
          if (route === "repos/acme/web/issues/42/comments") {
            const page = Number(new URLSearchParams(query).get("page"));
            return { stdout: encode(comments.slice((page - 1) * 20, page * 20)) };
          }
          if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        let cursor = "1";
        const ids: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.getComments({ ...target, cursor });
          ids.push(...result.comments.map((comment) => comment.id));
          expect(result.nextCursor).toBe(
            page === 4 ? null : `page:${page + 1}:${Math.min(page * 20, 50)}`,
          );
          expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(page);
          cursor = result.nextCursor ?? "";
        }
        expect(ids).toEqual(comments.map((comment) => String(comment.id)));
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(50);
      }),
  );

  it.effect("keeps native Forgejo page cursors and stops at a short final comment page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const route = input.path.split("?")[0]!;
        if (route === "repos/acme/web/issues/42/comments")
          return {
            stdout: encode([
              {
                id: 51,
                body: "Last comment",
                user: { login: "julius" },
                created_at: "2026-07-02T00:00:00Z",
              },
            ]),
            stderr:
              'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/comments?page=1>; rel="prev"',
          };
        if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
        return answer(input.path);
      });
      const page = yield* api.getComments({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        cursor: "2",
      });
      expect(page.comments.map((comment) => comment.id)).toEqual(["51"]);
      expect(page.nextCursor).toBeNull();
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
    }),
  );

  it.effect.each([
    { name: "a headerless native page with ten later comments", count: 60, paginated: true },
    {
      name: "an exact full unpaged response that ignores the page argument",
      count: 50,
      paginated: false,
    },
    {
      name: "a short unpaged response that ignores the page argument",
      count: 20,
      paginated: false,
    },
  ])("continues a headerless comment page and stops correctly for $name", ({ count, paginated }) =>
    Effect.gen(function* () {
      const comments = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      }));
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const [route, query] = input.path.split("?");
        if (route === "repos/acme/web/issues/42/comments") {
          const page = Number(new URLSearchParams(query).get("page"));
          return {
            stdout: encode(paginated ? comments.slice((page - 1) * 50, page * 50) : comments),
          };
        }
        if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      expect(first.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: Math.min(count, 50) }, (_, index) => String(index + 1)),
      );
      expect(first.commentsCursor).toBe(`page:2:${Math.min(count, 50)}`);
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(1);
      const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
      expect(second.comments.map((comment) => comment.id)).toEqual(
        paginated ? Array.from({ length: 10 }, (_, index) => String(index + 51)) : [],
      );
      expect(second.nextCursor).toBe(paginated ? "page:3:60" : null);
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=1",
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
      expect(paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path))).toHaveLength(
        count,
      );
      if (paginated) {
        const last = yield* api.getComments({ ...target, cursor: second.nextCursor! });
        expect(last.comments).toEqual([]);
        expect(last.nextCursor).toBeNull();
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(3);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(count);
      }
    }),
  );
});
