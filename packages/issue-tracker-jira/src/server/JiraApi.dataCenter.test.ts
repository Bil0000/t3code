import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  ConnectionId,
  IssueTrackerHost,
} from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";
import { JiraIssue, JiraUser, textToAdf } from "./jiraJson.ts";

const site = "https://jira.example.test:8443/Team/Jira";
const host = "jira.example.test:8443/Team/Jira";
const packed = JSON.stringify({ deployment: "data-center", site, token: "fake-pat" });
const user = { key: "JIRAUSER101", name: "ada.renamed", displayName: "Ada" };
const decodeSearchRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    jql: Schema.String,
    startAt: Schema.Int,
    fields: Schema.Array(Schema.String),
  }),
);
const issue = {
  id: "1",
  key: "ENG-1",
  fields: {
    project: { id: "20", key: "ENG" },
    summary: "Native task",
    description: "*bold* and !image.png|width=200! [link|https://example.test]",
    created: "2026-10-15T10:00:00Z",
    updated: "2026-10-15T11:00:00Z",
    creator: user,
    assignee: user,
    status: { id: "2", name: "Review", statusCategory: { key: "indeterminate" } },
  },
};

function fakeJira(
  reply: (request: HttpClientRequest.HttpClientRequest) => {
    readonly body?: unknown;
    readonly status?: number;
    readonly headers?: Record<string, string>;
  },
  credentials: Record<string, string> = { default: packed },
) {
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  const transport = HttpClient.make((request) => {
    calls.push(request);
    const response = reply(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          response.status === 204 || response.body === undefined
            ? null
            : JSON.stringify(response.body),
          {
            status: response.status ?? 200,
            ...(response.headers === undefined ? {} : { headers: response.headers }),
          },
        ),
      ),
    );
  });
  return {
    calls,
    api: JiraApi.make.pipe(
      Effect.provideService(HttpClient.HttpClient, transport),
      Effect.provideService(
        IssueTrackerHost,
        IssueTrackerHost.of({
          credentials: {
            get: (_kind, selected) =>
              Effect.map(ConnectionId, (current) =>
                Option.fromNullishOr(credentials[selected ?? current ?? "default"]),
              ),
          },
        }),
      ),
      Effect.provide(SourceControlRateLimit.layer),
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  };
}

function body(request: HttpClientRequest.HttpClientRequest | undefined): unknown {
  if (request?.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
  return JSON.parse(new TextDecoder().decode(request.body.body));
}

it.effect("probes a DC PAT at the exact base path and pages its native project array", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.endsWith("/myself")
        ? user
        : Array.from({ length: 102 }, (_, index) => ({
            id: String(index),
            key: `PRJ${index}`,
            name: `Project ${index}`,
          })),
    }));
    const api = yield* f.api;
    expect(yield* api.probeCredential(packed)).toEqual({
      account: "Ada",
      accountId: user.key,
      host,
      scopes: Array.from({ length: 100 }, (_, index) => ({
        key: `PRJ${index}`,
        name: `Project ${index}`,
      })),
      scopesCursor: "100",
      scopesTruncated: true,
    });
    expect(yield* api.listScopes(packed, { cursor: "100", limit: 2 })).toEqual({
      items: [
        { key: "PRJ100", name: "Project 100" },
        { key: "PRJ101", name: "Project 101" },
      ],
      nextCursor: null,
    });
    expect(f.calls.map((request) => request.url)).toEqual([
      `${site}/rest/api/2/myself`,
      `${site}/rest/api/2/project`,
      `${site}/rest/api/2/project`,
    ]);
    expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
      true,
    );
  }),
);

it.effect("maps DC offset search pages and stable user keys without changing wiki bodies", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { startAt: 2, total: 4, issues: [issue] } }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "listIssues",
      method: "POST",
      path: "/search/jql",
      body: {
        jql: 'project = "ENG"',
        maxResults: 2,
        nextPageToken: "2",
        fields: ["project", "summary"],
      },
      schema: Schema.Struct({
        issues: Schema.Array(JiraIssue),
        nextPageToken: Schema.optional(Schema.String),
        isLast: Schema.Boolean,
      }),
    });
    expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/search`);
    expect(body(f.calls[0])).toEqual({
      jql: 'project = "ENG"',
      maxResults: 2,
      startAt: 2,
      fields: ["project", "summary"],
    });
    expect(page.nextPageToken).toBe("3");
    expect(page.isLast).toBe(false);
    expect(page.issues[0]?.fields.creator?.accountId).toBe(user.key);
    expect(page.issues[0]?.fields.description).toBe(issue.fields.description);
  }),
);

it.effect("keeps DC native permission results and translates create metadata values", () =>
  Effect.gen(function* () {
    const denied = { permissions: { EDIT_ISSUES: { havePermission: false } } };
    const f = fakeJira((request) => ({
      body: request.url.includes("/mypermissions")
        ? denied
        : {
            start: 0,
            size: 100,
            last: true,
            values: [{ fieldId: "description", required: false }],
          },
    }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getViewerPermissions",
        method: "GET",
        path: "/mypermissions?issueKey=ENG-1&permissions=EDIT_ISSUES",
        schema: Schema.Unknown,
      }),
    ).toEqual(denied);
    expect(
      yield* api.request({
        host,
        operation: "create",
        method: "GET",
        path: "/issue/createmeta/ENG/issuetypes/100?startAt=0&maxResults=100",
        schema: Schema.Unknown,
      }),
    ).toMatchObject({ fields: [{ fieldId: "description", required: false }] });
  }),
);

it.effect(
  "uses the selected account for DC requests and rejects another instance before HTTP",
  () =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({ body: user }), {
        default: JSON.stringify({
          site: "cloud.atlassian.net",
          email: "cloud@test",
          token: "cloud",
        }),
        dc: packed,
      });
      const api = yield* f.api;
      const read = (requestedHost: string) =>
        api
          .request({
            host: requestedHost,
            operation: "getViewer",
            method: "GET",
            path: "/myself",
            schema: JiraUser,
          })
          .pipe(Effect.provideService(ConnectionId, "dc"));
      expect((yield* read(host)).accountId).toBe(user.key);
      for (const other of ["jira.example.test:8443/team/Jira", "jira.example.test:9443/Team/Jira"])
        expect(yield* read(other).pipe(Effect.flip)).toMatchObject({ reason: "unauthenticated" });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.headers.authorization).toBe("Bearer fake-pat");
    }),
);

it.effect("rejects rich ADF writes to DC before sending a mutation", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 204 }));
    const api = yield* f.api;
    const rich = textToAdf("keep bold");
    const document = {
      ...rich,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }],
        },
      ],
    };
    expect(
      yield* api
        .request({
          host,
          operation: "update",
          method: "PUT",
          path: "/issue/ENG-1",
          body: { fields: { description: document } },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("reads deployment from the selected credential without HTTP", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 500 }), {
      default: JSON.stringify({ site: "cloud.atlassian.net", email: "cloud@test", token: "cloud" }),
      dc: packed,
    });
    const api = yield* f.api;
    expect(yield* api.deploymentFor("cloud.atlassian.net")).toBe("cloud");
    expect(yield* api.deploymentFor(host).pipe(Effect.provideService(ConnectionId, "dc"))).toBe(
      "data-center",
    );
    expect(yield* api.deploymentFor(host).pipe(Effect.flip)).toMatchObject({
      reason: "unauthenticated",
    });
    expect(JiraApi.jiraIssueUrl(host, "ENG-1")).toBe(`${site}/browse/ENG-1`);
    expect(JiraApi.normalizeJiraInstanceHost("https://JIRA.example.test:8443/Team/Jira/")).toBe(
      host,
    );
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("resolves a stable DC assignee key and writes native user names and string bodies", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) =>
      request.url.includes("/user?key=") ? { body: user } : { status: 204 },
    );
    const api = yield* f.api;
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1",
      body: {
        fields: {
          assignee: { accountId: user.key },
          description: textToAdf("first\nsecond\n\nthird"),
        },
      },
      schema: Schema.Undefined,
    });
    expect(f.calls.map((request) => request.url)).toEqual([
      `${site}/rest/api/2/user?key=JIRAUSER101`,
      `${site}/rest/api/2/issue/ENG-1`,
    ]);
    expect(body(f.calls[1])).toEqual({
      fields: { assignee: { name: "ada.renamed" }, description: "first\nsecond\n\nthird" },
    });
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1/assignee",
      body: { accountId: user.key },
      schema: Schema.Undefined,
    });
    expect(body(f.calls[3])).toEqual({ name: "ada.renamed" });
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1/assignee",
      body: { accountId: null },
      schema: Schema.Undefined,
    });
    expect(body(f.calls[4])).toEqual({ name: null });
    expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
      true,
    );
  }),
);

it.effect("does not mutate when DC cannot resolve the selected native account key", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { ...user, key: "JIRAUSER999" } }));
    const api = yield* f.api;
    expect(
      yield* api
        .request({
          host,
          operation: "update",
          method: "PUT",
          path: "/issue/ENG-1/assignee",
          body: { accountId: user.key },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls.map((request) => request.method)).toEqual(["GET"]);
  }),
);

it.effect("keeps native wiki comment bodies and uses public v2 comment operations", () =>
  Effect.gen(function* () {
    const comment = {
      id: "30",
      author: user,
      body: issue.fields.description,
      created: issue.fields.created,
      updated: issue.fields.updated,
    };
    const f = fakeJira((request) => ({
      body:
        request.method === "GET" && !request.url.endsWith("/30")
          ? { startAt: 0, total: 1, comments: [comment] }
          : comment,
    }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "getComments",
      method: "GET",
      path: "/issue/ENG-1/comment?orderBy=-created&startAt=0&maxResults=50",
      schema: Schema.Struct({
        comments: Schema.Array(Schema.Struct({ body: Schema.String, author: JiraUser })),
      }),
    });
    expect(page.comments[0]).toMatchObject({ body: comment.body, author: { accountId: user.key } });
    for (const method of ["POST", "PUT"] as const) {
      yield* api.request({
        host,
        operation: method === "POST" ? "comment" : "editComment",
        method,
        path: "/issue/ENG-1/comment" + (method === "PUT" ? "/30" : ""),
        body: { body: comment.body },
        schema: Schema.Unknown,
      });
      expect(body(f.calls.at(-1))).toEqual({ body: comment.body });
    }
    expect(f.calls[0]?.url).toBe(
      `${site}/rest/api/2/issue/ENG-1/comment?orderBy=-created&startAt=0&maxResults=50`,
    );
  }),
);

it.effect("adapts DC expanded changelog reads and refuses incomplete native history", () =>
  Effect.gen(function* () {
    const histories = Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      author: user,
      created: issue.fields.created,
      items: [],
    }));
    let total = 3;
    const f = fakeJira(() => ({ body: { changelog: { startAt: 0, total, histories } } }));
    const api = yield* f.api;
    const read = () =>
      api.request({
        host,
        operation: "getHistory",
        method: "GET",
        path: "/issue/ENG-1/changelog?startAt=1&maxResults=1",
        schema: Schema.Struct({
          startAt: Schema.Int,
          total: Schema.Int,
          isLast: Schema.Boolean,
          values: Schema.Array(Schema.Struct({ id: Schema.String, author: JiraUser })),
        }),
      });
    expect(yield* read()).toMatchObject({
      startAt: 1,
      total: 3,
      isLast: false,
      values: [{ id: "1", author: { accountId: user.key } }],
    });
    expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/issue/ENG-1?fields=project&expand=changelog`);
    total = 4;
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "failed" });
  }),
);

it.effect(
  "adapts DC issue type pages and keeps scope reads bound to their supplied credential",
  () =>
    Effect.gen(function* () {
      const f = fakeJira(
        (request) => ({
          body: request.url.includes("/issuetypes")
            ? {
                start: 0,
                size: 100,
                last: true,
                values: [{ id: "100", name: "Task", subtask: false }],
              }
            : { key: "ENG", name: "Engineering" },
        }),
        {},
      );
      const api = yield* f.api;
      expect(yield* api.getScope(packed, "ENG")).toEqual({ key: "ENG", name: "Engineering" });
      expect(
        yield* api.request({
          host,
          credential: packed,
          operation: "issueTypes",
          method: "GET",
          path: "/issue/createmeta/ENG/issuetypes?startAt=0&maxResults=100",
          schema: Schema.Unknown,
        }),
      ).toMatchObject({
        issueTypes: [{ id: "100", name: "Task", subtask: false }],
      });
      expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/project/ENG`);
    }),
);

it.effect.each([
  "https://jira.example.test/Team/Jira",
  "http://jira.example.test:8443/Team/Jira",
  "https://user:pass@jira.example.test/Team/Jira",
  "https://jira.example.test/Team/Jira?other=1",
  "https://jira.example.test/Team/Jira#other",
])("does not let a legacy Cloud credential select the DC instance %s", (site) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: user }));
    const api = yield* f.api;
    expect(
      yield* api
        .probeCredential(JSON.stringify({ site, email: "ada@test", token: "fake-token" }))
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "unauthenticated" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect.each(["opaque-cloud-token", "-1", "01", "9007199254740992"])(
  "rejects an invalid DC search cursor %s before HTTP",
  (cursor) =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({ body: { startAt: 0, total: 0, issues: [] } }));
      const api = yield* f.api;
      expect(
        yield* api
          .request({
            host,
            operation: "listIssues",
            method: "POST",
            path: "/search/jql",
            body: { jql: "project = ENG", maxResults: 2, nextPageToken: cursor },
            schema: Schema.Struct({ issues: Schema.Array(JiraIssue) }),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(f.calls).toHaveLength(0);
    }),
);

it.effect("preserves DC rate-limit and response-size budgets", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 429, body: {}, headers: { "retry-after": "60" } }));
    const api = yield* f.api;
    const read = () =>
      api.request({
        host,
        operation: "getViewer",
        method: "GET",
        path: "/myself",
        schema: JiraUser,
      });
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "rate-limited" });
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "rate-limited" });
    expect(f.calls).toHaveLength(1);
    const oversized = fakeJira(() => ({
      body: { ...user, displayName: "x".repeat(2 * 1024 * 1024) },
    }));
    const largeApi = yield* oversized.api;
    expect(
      yield* largeApi
        .request({ host, operation: "getViewer", method: "GET", path: "/myself", schema: JiraUser })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
  }),
);

it.effect("does not invent a total for a DC metadata page that reports more rows", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        start: 100,
        size: 100,
        last: false,
        values: [{ fieldId: "summary", required: true }],
      },
    }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "create",
      method: "GET",
      path: "/issue/createmeta/ENG/issuetypes/100?startAt=100&maxResults=100",
      schema: Schema.Struct({
        startAt: Schema.Int,
        isLast: Schema.Boolean,
        total: Schema.optional(Schema.Int),
      }),
    });
    expect(page).toEqual({ startAt: 100, isLast: false });
  }),
);

it.effect("limits DC assignable-user reads to the documented first 100 native users", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: [user] }));
    const api = yield* f.api;
    const read = (startAt: number) =>
      api.request({
        host,
        operation: "listAssigneeCandidates",
        method: "GET",
        path: `/user/assignable/search?project=ENG&startAt=${startAt}&maxResults=200`,
        schema: Schema.Array(JiraUser),
      });
    expect((yield* read(0))[0]?.accountId).toBe(user.key);
    expect(f.calls[0]?.url).toBe(
      `${site}/rest/api/2/user/assignable/search?project=ENG&maxResults=100`,
    );
    expect(yield* read(100).pipe(Effect.flip)).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect("rejects DC parent mutations without pretending a permission grant supports them", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 204 }));
    const api = yield* f.api;
    expect(
      yield* api
        .request({
          host,
          operation: "setParent",
          method: "PUT",
          path: "/issue/ENG-1",
          body: { fields: { parent: { key: "ENG-2" } } },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("uses the native username only when a legacy DC user has no key", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { name: "legacy.user", displayName: "Legacy" } }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getViewer",
        method: "GET",
        path: "/myself",
        schema: JiraUser,
      }),
    ).toMatchObject({ accountId: "legacy.user" });
  }),
);

it.each(["https://jira.example.test/Team/../Other", "https://jira.example.test/Team/%2e%2e/Other"])(
  "rejects a DC instance URL that normalizes a different native base path: %s",
  (site) => expect(() => JiraApi.normalizeJiraInstanceHost(site)).toThrow(),
);

it.effect("keeps embedded DC history truncation visible and reloads displaced comment pages", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        ...issue,
        fields: {
          ...issue.fields,
          comment: {
            startAt: 10,
            total: 20,
            comments: [
              {
                id: "c1",
                author: user,
                body: "keep",
                created: issue.fields.created,
                updated: issue.fields.updated,
              },
            ],
          },
        },
        changelog: {
          histories: Array.from({ length: 101 }, (_, index) => ({
            id: String(index),
            author: user,
            created: issue.fields.created,
            items: [],
          })),
        },
      },
    }));
    const api = yield* f.api;
    const detail = yield* api.request({
      host,
      operation: "getIssue",
      method: "GET",
      path: "/issue/ENG-1?expand=changelog",
      schema: JiraIssue,
    });
    expect(detail.changelog?.histories).toHaveLength(100);
    expect(detail.changelog?.total).toBe(101);
    expect(detail.fields.comment).toEqual({ startAt: 10, total: 20 });
  }),
);

it.effect.each(["listIssues", "listLabelCandidates", "getHierarchy", "listCandidates"] as const)(
  "runs DC %s through the real tracker and transport with native search field arrays",
  (operation) =>
    Effect.gen(function* () {
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1", viewer: user.key };
      const f = fakeJira((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/search")) {
          const search = decodeSearchRequest(body(request));
          const child = search.jql.startsWith("parent = ") || search.startAt > 0;
          return {
            body: {
              startAt: search.startAt,
              total: operation === "listIssues" ? 2 : 1,
              issues: [
                {
                  ...issue,
                  key: child ? "ENG-2" : "ENG-1",
                  fields: {
                    ...issue.fields,
                    labels: ["bug"],
                    ...(child ? { parent: { key: "ENG-1" } } : {}),
                  },
                },
              ],
            },
          };
        }
        if (path.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (path.endsWith("/transitions")) return { body: { transitions: [] } };
        if (path.endsWith("/statuses")) return { body: [{ statuses: [issue.fields.status] }] };
        return { body: issue };
      });
      const tracker = yield* JiraIssueTracker.make.pipe(
        Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
      );
      if (operation === "listIssues") {
        const first = yield* tracker.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          limit: 1,
        });
        expect(first.items[0]?.key).toBe("ENG-1");
        expect(first.nextCursor).toBe("1");
        const second = yield* tracker.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items[0]?.key).toBe("ENG-2");
        expect(second.nextCursor).toBeNull();
      } else if (operation === "listLabelCandidates") {
        expect(yield* tracker.listLabelCandidates!({ ...target, limit: 1 })).toEqual({
          items: [{ name: "bug", color: null, description: null }],
          nextCursor: null,
        });
      } else if (operation === "getHierarchy") {
        const hierarchy = yield* tracker.getHierarchy!({ ...target, limit: 1 });
        expect(hierarchy.parent).toBeNull();
        expect(hierarchy.children.items[0]).toMatchObject({
          key: "ENG-2",
          url: `${site}/browse/ENG-2`,
        });
        expect(hierarchy.children.nextCursor).toBeNull();
      } else {
        const candidates = yield* tracker.listCandidates!(target);
        expect(candidates.labels).toEqual([{ name: "bug", color: null, description: null }]);
        expect(candidates.assignees).toEqual([]);
      }
      const searches = f.calls.filter((request) => request.method === "POST");
      expect(searches).toHaveLength(operation === "listIssues" ? 2 : 1);
      for (const request of searches) {
        expect(request.url).toBe(`${site}/rest/api/2/search`);
        expect(body(request)).toMatchObject({
          fields: expect.arrayContaining(["project", "labels"]),
          startAt: expect.any(Number),
        });
        expect(body(request)).not.toHaveProperty("nextPageToken");
      }
      expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
        true,
      );
    }),
);

it.effect("normalizes complete DC embedded comments to a bounded newest page", () =>
  Effect.gen(function* () {
    const comments = Array.from({ length: 60 }, (_, index) => ({ id: String(index + 1) }));
    const f = fakeJira(() => ({
      body: {
        ...issue,
        fields: { ...issue.fields, comment: { startAt: 0, maxResults: 60, total: 60, comments } },
      },
    }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getIssue",
        method: "GET",
        path: "/issue/ENG-1",
        schema: Schema.Unknown,
      }),
    ).toMatchObject({
      fields: { comment: { startAt: 0, maxResults: 50, total: 60, comments: comments.slice(-50) } },
    });
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect.each([
  { name: "complete 60", total: 60, startAt: 0, embedded: 60, offsets: [50], canEdit: true },
  { name: "incomplete 60", total: 60, startAt: 0, embedded: 10, offsets: [0, 50], canEdit: true },
  { name: "displaced 60", total: 60, startAt: 10, embedded: 10, offsets: [0, 50], canEdit: false },
  { name: "complete 50", total: 50, startAt: 0, embedded: 50, offsets: [], canEdit: true },
  { name: "complete 3", total: 3, startAt: 0, embedded: 3, offsets: [], canEdit: false },
  { name: "empty", total: 0, startAt: 0, embedded: 0, offsets: [], canEdit: false },
])("loads every DC comment exactly once for $name embedded comments", (scenario) =>
  Effect.gen(function* () {
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
    const native = Array.from({ length: scenario.total }, (_, index) => ({
      id: String(index + 1),
      author: user,
      body: `Comment ${index + 1}`,
      created: `2026-10-15T10:${String(index).padStart(2, "0")}:00Z`,
      updated: `2026-10-15T10:${String(index).padStart(2, "0")}:00Z`,
    }));
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/myself")) return { body: user };
      if (url.pathname.endsWith("/mypermissions"))
        return {
          body: { permissions: { EDIT_OWN_COMMENTS: { havePermission: scenario.canEdit } } },
        };
      if (url.pathname.endsWith("/remotelink")) return { body: [] };
      if (url.pathname.endsWith("/comment")) {
        const startAt = Number(url.searchParams.get("startAt"));
        const maxResults = Number(url.searchParams.get("maxResults"));
        expect(url.searchParams.get("orderBy")).toBe("-created");
        expect(maxResults).toBe(50);
        return {
          body: {
            startAt,
            maxResults,
            total: native.length,
            comments: native.toReversed().slice(startAt, startAt + maxResults),
          },
        };
      }
      if (url.pathname.endsWith("/issue/ENG-1"))
        return {
          body: {
            ...issue,
            fields: {
              ...issue.fields,
              comment: {
                startAt: scenario.startAt,
                maxResults: scenario.embedded,
                total: native.length,
                comments: native.slice(scenario.startAt, scenario.startAt + scenario.embedded),
              },
            },
            changelog: { startAt: 0, total: 0, histories: [] },
          },
        };
      throw new Error(`Unexpected fake Jira request: ${request.url}`);
    });
    const tracker = yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
    );
    const detail = yield* tracker.getIssue(target);
    const loaded = [...detail.comments];
    let cursor = detail.commentsCursor;
    for (let page = 0; cursor !== null && page < 2; page++) {
      const next = yield* tracker.getComments({ ...target, cursor, viewer: user.key });
      loaded.push(...next.comments);
      cursor = next.nextCursor;
    }
    const ids = loaded.map((comment) => comment.id);
    expect(ids).toHaveLength(scenario.total);
    expect(new Set(ids).size).toBe(scenario.total);
    expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(
      native.map((comment) => comment.id),
    );
    expect(detail.comments.map((comment) => comment.id)).toEqual(
      native.slice(-50).map((comment) => comment.id),
    );
    expect(detail.comments).toHaveLength(Math.min(50, scenario.total));
    expect(detail.commentsCursor).toBe(scenario.total > 50 ? "50" : null);
    expect(cursor).toBeNull();
    expect(loaded.every((comment) => comment.canEdit === scenario.canEdit)).toBe(true);
    for (const comment of loaded)
      expect(comment.richBody).toEqual({ format: "jira-wiki", document: comment.body });
    expect(detail.bodyEditable).toBe(false);
    const pages = f.calls.filter((request) => new URL(request.url).pathname.endsWith("/comment"));
    expect(
      pages.map((request) => Number(new URL(request.url).searchParams.get("startAt"))),
    ).toEqual(scenario.offsets);
    expect(f.calls).toHaveLength(
      4 + scenario.offsets.reduce((total, offset) => total + (offset === 0 ? 1 : 3), 0),
    );
    expect(
      f.calls.every(
        (request) =>
          request.method === "GET" && request.headers.authorization === "Bearer fake-pat",
      ),
    ).toBe(true);
  }),
);

it.effect("stops DC comment loading when native comment permissions return 403", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/issue/ENG-1")) return { body: issue };
      if (path.endsWith("/mypermissions")) return { status: 403 };
      throw new Error(`Unexpected fake Jira request: ${request.url}`);
    });
    const tracker = yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
    );
    expect(
      yield* tracker
        .getComments({
          cwd: "/tmp",
          host,
          scope: "ENG",
          key: "ENG-1",
          viewer: user.key,
          cursor: "0",
        })
        .pipe(Effect.flip),
    ).toMatchObject({
      operation: "getComments",
      reason: "failed",
      detail: "Jira returned HTTP 403.",
    });
    expect(f.calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/Team/Jira/rest/api/2/issue/ENG-1",
      "/Team/Jira/rest/api/2/mypermissions",
    ]);
    expect(f.calls.every((request) => request.method === "GET")).toBe(true);
  }),
);
