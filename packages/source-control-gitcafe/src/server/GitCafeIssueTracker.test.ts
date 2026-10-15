import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeIssueTracker from "./GitCafeIssueTracker.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";

const timestamp = "2026-10-15T12:00:00Z";
const actor = {
  kind: "local",
  actorId: "act_alice",
  handle: "alice",
  displayName: null,
  avatarUrl: null,
};
const issue = {
  id: "issue_one",
  number: 7,
  title: "Native issue",
  description: "Body",
  stateType: "triage",
  version: 4,
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  closedAt: null,
  closedReason: null,
  labels: [],
  assignees: [],
  milestone: null,
  capabilities: {
    edit: true,
    comment: true,
    close: true,
    reopen: false,
    manageLabels: true,
    manageAssignees: true,
  },
};
const comment = {
  id: "comment_one",
  issueId: "issue_one",
  author: actor,
  body: "Comment",
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  capabilities: { edit: true, delete: true },
};
const target = { cwd: "/repo", host: "git.cafe", scope: "owner/repo", key: "7" };
const base = "/repos/owner/repo/issues/7";
const page = { items: [], next: null };

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function harness(routes: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const invalidated: string[] = [];
  const defaults: Record<string, unknown> = {
    "GET /auth/principal": { actorId: "act_alice", handle: "alice" },
    [`GET ${base}`]: issue,
    [`GET ${base}/comments/`]: { items: [comment], next: null },
    [`GET ${base}/links/`]: page,
    [`GET ${base}/reactions/`]: page,
    "GET /repos/owner/repo/labels": page,
    "GET /repos/owner/repo/issues/assignee-candidates": page,
  };
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    const url = new URL(request.url);
    assert.strictEqual(url.origin, "https://git.cafe");
    assert.strictEqual(request.headers.authorization, "Bearer fake-token");
    assert.strictEqual(
      Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      "manual",
    );
    const input: Sent = {
      method: request.method,
      path: url.pathname.slice(4),
      query: url.searchParams,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    sent.push(input);
    const route = { ...defaults, ...routes }[`${input.method} ${input.path}`];
    const value = typeof route === "function" ? route(input) : route;
    const response =
      value instanceof Response
        ? value.clone()
        : new Response(JSON.stringify(value ?? {}), { status: route === undefined ? 404 : 200 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = GitCafeApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(
      Layer.succeed(GitCafeCredentials.GitCafeCredentials, {
        get: (host) => Effect.succeed({ host, token: Redacted.make("fake-token"), source: "env" }),
        invalidate: (host) =>
          Effect.sync(() => {
            invalidated.push(host);
          }),
        cliEnv: () => Effect.succeed({}),
      }),
    ),
  );
  return { layer, sent, invalidated };
}

describe("GitCafeIssueTracker", () => {
  it.effect("preserves full native cursors without cutting them", () => {
    const cursor = "a".repeat(8192);
    const fake = harness({ "GET /repos/owner/repo/issues/": { items: [issue], next: cursor } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 1,
      };
      const first = yield* api.listIssues(input);
      assert.strictEqual(first.nextCursor, cursor);
      yield* api.listIssues({ ...input, cursor }).pipe(Effect.flip);
      assert.strictEqual(fake.sent[1]?.query.get("after"), cursor);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "does not turn unreadable, oversized or foreign conversation pages into empty success",
    () => {
      const malformed = harness({
        "GET /repos/owner/repo/issues/": { items: [{ number: "bad" }], next: null },
      });
      const oversized = harness({
        "GET /repos/owner/repo/issues/": { items: [issue, issue], next: null },
      });
      const foreign = harness({
        [`GET ${base}/comments/`]: {
          items: [{ ...comment, issueId: "another_issue" }],
          next: null,
        },
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const error = yield* api
          .listIssues({ ...target, state: "all", involvement: "all", viewer: "alice", limit: 1 })
          .pipe(Effect.flip);
        assert.include(error.detail, "unreadable");
      }).pipe(
        Effect.provide(malformed.layer),
        Effect.andThen(
          Effect.gen(function* () {
            const api = yield* GitCafeIssueTracker.make;
            const error = yield* api
              .listIssues({
                ...target,
                state: "all",
                involvement: "all",
                viewer: "alice",
                limit: 1,
              })
              .pipe(Effect.flip);
            assert.include(error.detail, "continuation");
          }).pipe(Effect.provide(oversized.layer)),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            const api = yield* GitCafeIssueTracker.make;
            const error = yield* api.getIssue(target).pipe(Effect.flip);
            assert.include(error.detail, "different issue");
          }).pipe(Effect.provide(foreign.layer)),
        ),
      );
    },
  );

  it.effect("keeps unavailable assignee IDs and ignores a malformed avatar", () => {
    const unavailable = {
      id: "act_missing",
      actor: { kind: "unavailable", actorId: "act_missing" },
    };
    const fake = harness({
      [`GET ${base}`]: {
        ...issue,
        author: { ...actor, avatarUrl: "http://[" },
        assignees: [unavailable],
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.assignees[0]?.id, "act_missing");
      assert.strictEqual(result.assignees[0]?.login, "act_missing");
      assert.strictEqual(result.author?.avatarUrl, null);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("does not require code-read scope to display an issue without reaction access", () => {
    const fake = harness({ [`GET ${base}/reactions/`]: new Response("denied", { status: 403 }) });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.title, issue.title);
      assert.strictEqual(result.reactions, undefined);
      assert.strictEqual(result.comments[0]?.reactions, undefined);
      assert.strictEqual(fake.sent.length, 5);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("keeps issue and comment reactions apart when native IDs match", () => {
    const reaction = {
      emoji: { kind: "unicode", value: "👍" },
      count: 1,
      viewerReactionId: null,
      reactors: [],
    };
    const fake = harness({
      [`GET ${base}/comments/`]: { items: [{ ...comment, id: "issue_one" }], next: null },
      [`GET ${base}/reactions/`]: {
        items: [
          { ...reaction, subject: { kind: "issue", id: "issue_one" } },
          { ...reaction, count: 2, subject: { kind: "issue_comment", id: "issue_one" } },
        ],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.reactions?.[0]?.count, 1);
      assert.strictEqual(result.comments[0]?.reactions?.[0]?.count, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("bounds comment lookup and refuses native per-comment edit denial", () => {
    const missing = harness({
      [`GET ${base}/comments/`]: (input: Sent) => ({
        items: [],
        next: `page_${Number(input.query.get("after")?.slice(5) ?? 0) + 1}`,
      }),
    });
    const denied = harness({
      [`GET ${base}/comments/`]: {
        items: [{ ...comment, capabilities: { edit: false, delete: false } }],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.editComment!({ ...target, commentId: "missing", body: "Edit" }).pipe(
        Effect.flip,
      );
      assert.include(error.detail, "bound");
      assert.strictEqual(missing.sent.length, 10);
    }).pipe(
      Effect.provide(missing.layer),
      Effect.andThen(
        Effect.gen(function* () {
          const api = yield* GitCafeIssueTracker.make;
          const error = yield* api.editComment!({
            ...target,
            commentId: comment.id,
            body: "Edit",
          }).pipe(Effect.flip);
          assert.include(error.detail, "does not allow");
          assert.strictEqual(denied.sent.length, 1);
        }).pipe(Effect.provide(denied.layer)),
      ),
    );
  });
  it.effect("uses native actor IDs and explicit all-state filters with one list page", () => {
    const fake = harness({
      "GET /repos/owner/repo/issues/": { items: [issue], next: "next_page" },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "assigned",
        viewer: "alice",
        limit: 200,
        sort: "updated",
        order: "asc",
        query: "fix",
      });
      assert.strictEqual(result.nextCursor, "next_page");
      assert.strictEqual(result.items[0]?.author?.id, "act_alice");
      assert.strictEqual(fake.sent.length, 2);
      const query = fake.sent[1]!.query;
      assert.deepStrictEqual(query.getAll("statuses"), ["open", "closed"]);
      assert.strictEqual(query.get("assignee"), "act_alice");
      assert.strictEqual(query.get("limit"), "100");
      assert.strictEqual(query.get("direction"), "asc");
      assert.strictEqual(query.get("q"), "fix");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([
    {
      categories: ["backlog", "unstarted", "started"],
      state: "open",
      states: ["triage", "backlog", "unstarted", "started"],
    },
    { categories: ["backlog"], state: "open", states: ["triage", "backlog"] },
    { categories: ["unstarted"], state: "open", states: ["triage", "unstarted"] },
    { categories: ["started"], state: "open", states: ["triage", "started"] },
    { categories: ["completed", "canceled"], state: "closed", states: ["completed", "canceled"] },
    { categories: ["backlog", "unstarted", "started"], state: "closed", states: [] },
  ] as const)(
    "keeps triage reachable for $state categories $categories",
    ({ categories, state, states }) => {
      const fake = harness({
        "GET /repos/owner/repo/issues/": ({ query }: Sent) => ({
          items: query.getAll("states").includes("triage") ? [issue] : [],
          next: null,
        }),
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const result = yield* api.listIssues({
          ...target,
          state,
          stateCategories: categories,
          involvement: "all",
          viewer: "alice",
          limit: 50,
        });
        assert.strictEqual(result.items.length, states.some((value) => value === "triage") ? 1 : 0);
        if (states.length === 0) assert.strictEqual(fake.sent.length, 0);
        else {
          assert.strictEqual(fake.sent.length, 1);
          assert.deepStrictEqual(fake.sent[0]!.query.getAll("states"), [...states]);
          if (result.items.length > 0) {
            assert.strictEqual(result.items[0]?.state.id, "triage");
            assert.strictEqual(result.items[0]?.state.category, "open");
          }
        }
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("handles terminal pages, empty categories and account changes without guessing", () => {
    const fake = harness({ "GET /repos/owner/repo/issues/": page });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 10,
      };
      const empty = yield* api.listIssues({ ...input, stateCategories: [] });
      assert.deepStrictEqual(empty, { items: [], nextCursor: null });
      assert.strictEqual(fake.sent.length, 0);
      const terminal = yield* api.listIssues(input);
      assert.deepStrictEqual(terminal, empty);
      const changed = yield* api
        .listIssues({ ...input, involvement: "authored", viewer: "bob" })
        .pipe(Effect.flip);
      assert.include(changed.detail, "account changed");
      assert.strictEqual(fake.sent.length, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rejects malformed, oversized and repeated continuation pages", () => {
    const fake = harness({ "GET /repos/owner/repo/issues/": { items: [issue], next: "same" } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 10,
      };
      const repeated = yield* api.listIssues({ ...input, cursor: "same" }).pipe(Effect.flip);
      assert.include(repeated.detail, "continuation");
      const invalid = yield* api.listIssues({ ...input, cursor: "bad?cursor" }).pipe(Effect.flip);
      assert.include(invalid.detail, "page parameters");
      const forbidden = yield* api.listIssues({ ...input, host: "cafe.sh" }).pipe(Effect.flip);
      assert.include(forbidden.detail, "supported host");
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("loads comments and linked PRs as separate pages without extra PR reads", () => {
    const fake = harness({
      [`GET ${base}/comments/`]: { items: [comment], next: "older" },
      [`GET ${base}/links/`]: {
        items: [
          { issueId: "issue_one", number: 9, title: "Fix", state: "open", linkType: "closes" },
        ],
        next: "links_next",
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const comments = yield* api.getComments({ ...target, cursor: "first" });
      assert.strictEqual(comments.nextCursor, "older");
      assert.strictEqual(fake.sent[0]?.query.get("after"), "first");
      const links = yield* api.getLinkedPullRequests!({ ...target, limit: 5 });
      assert.strictEqual(links.nextCursor, "links_next");
      assert.strictEqual(links.items[0]?.url, "https://git.cafe/owner/repo/pulls/9");
      assert.strictEqual(links.items[0]?.closesIssue, true);
      assert.strictEqual(links.items[0]?.isDraft, undefined);
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("creates with native metadata IDs in one write", () => {
    const fake = harness({ "POST /repos/owner/repo/issues/": issue });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const created = yield* api.create!({
        ...target,
        title: "New",
        body: "Text",
        labels: ["label_one"],
        assignees: ["act_alice"],
      });
      assert.strictEqual(created.key, "7");
      assert.deepStrictEqual(fake.sent[0]?.body, {
        title: "New",
        description: "Text",
        labelIds: ["label_one"],
        assigneeIds: ["act_alice"],
      });
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("chains versions across word, label and assignee writes", () => {
    let version = 4;
    const write = (input: Sent) => {
      assert.strictEqual((input.body as { expectedVersion: number }).expectedVersion, version);
      version++;
      return { version };
    };
    const fake = harness({
      [`PATCH ${base}`]: write,
      [`PUT ${base}/labels`]: write,
      [`PUT ${base}/assignees`]: write,
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.update!({
        ...target,
        title: "Edit",
        body: "New body",
        labels: [],
        assignees: ["act_alice"],
      });
      assert.strictEqual(fake.sent.length, 4);
      assert.strictEqual(version, 7);
      assert.deepStrictEqual(fake.sent[2]?.body, { expectedVersion: 5, labelIds: [] });
      assert.deepStrictEqual(fake.sent[3]?.body, { expectedVersion: 6, actorIds: ["act_alice"] });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("preflights permissions and reports partial edits without sending later writes", () => {
    const fake = harness({
      [`PATCH ${base}`]: { version: 5 },
      [`PUT ${base}/labels`]: new Response("private input", { status: 409 }),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.update!({
        ...target,
        title: "Edit",
        labels: [],
        assignees: [],
      }).pipe(Effect.flip);
      assert.include(error.detail, "saved part");
      assert.notInclude(error.detail, "private input");
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses revoked metadata, comment and lifecycle permissions before writes", () => {
    const fake = harness({
      [`GET ${base}`]: {
        ...issue,
        capabilities: { ...issue.capabilities, manageLabels: false, close: false, comment: false },
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.update!({ ...target, labels: [] }).pipe(Effect.flip);
      yield* api.setState!({ ...target, state: "completed" }).pipe(Effect.flip);
      yield* api.comment!({ ...target, body: "No" }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 3);
      assert.isTrue(fake.sent.every((request) => request.method === "GET"));
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reopens then sets the requested workflow state with the returned version", () => {
    const closed = {
      ...issue,
      stateType: "completed",
      capabilities: { ...issue.capabilities, reopen: true },
    };
    const fake = harness({
      [`GET ${base}`]: closed,
      [`POST ${base}/reopen`]: { ...issue, version: 5, stateType: "unstarted" },
      [`PATCH ${base}`]: { ...issue, version: 6, stateType: "started" },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setState!({ ...target, state: "started" });
      assert.deepStrictEqual(fake.sent[1]?.body, { expectedVersion: 4 });
      assert.deepStrictEqual(fake.sent[2]?.body, { expectedVersion: 5, state: "started" });
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("closes as canceled and keeps comment edits on native IDs and versions", () => {
    const fake = harness({
      [`POST ${base}/close`]: { ...issue, stateType: "canceled", version: 5 },
      [`POST ${base}/comments/`]: comment,
      [`PATCH ${base}/comments/comment_one`]: comment,
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setState!({ ...target, state: "canceled" });
      assert.deepStrictEqual(fake.sent[1]?.body, { expectedVersion: 4, state: "canceled" });
      yield* api.comment!({ ...target, body: "Text" });
      yield* api.editComment!({ ...target, commentId: "comment_one", body: "Edit" });
      assert.deepStrictEqual(fake.sent.at(-1)?.body, { expectedVersion: 2, body: "Edit" });
      assert.strictEqual(fake.sent.length, 6);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("pages label and assignee choices with stable IDs and real truncation", () => {
    const fake = harness({
      "GET /repos/owner/repo/labels": {
        items: [{ id: "label_one", name: "bug", color: "#ff0000", description: null }],
        next: "labels_more",
      },
      "GET /repos/owner/repo/issues/assignee-candidates": {
        items: [{ id: "act_alice", actor }],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.listCandidates!(target);
      assert.strictEqual(result.labels[0]?.id, "label_one");
      assert.strictEqual(result.assignees[0]?.id, "act_alice");
      assert.strictEqual(result.truncated, true);
      const next = yield* api.listLabelCandidates!({ ...target, cursor: "labels_first", limit: 7 });
      assert.strictEqual(next.nextCursor, "labels_more");
      assert.strictEqual(fake.sent[2]?.query.get("after"), "labels_first");
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("adds and removes native reactions using the viewer reaction ID", () => {
    let reacted = false;
    const fake = harness({
      [`GET ${base}/reactions/`]: () => ({
        items: reacted
          ? [
              {
                subject: { kind: "issue", id: "issue_one" },
                emoji: { kind: "unicode", value: "👍" },
                count: 1,
                viewerReactionId: "reaction_one",
                reactors: [actor],
              },
            ]
          : [],
        next: null,
      }),
      [`POST ${base}/reactions/`]: () => {
        reacted = true;
        return {};
      },
      [`DELETE ${base}/reactions/reaction_one`]: () => {
        reacted = false;
        return new Response(null, { status: 204 });
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: false });
      assert.strictEqual(reacted, false);
      assert.strictEqual(fake.sent.filter((value) => value.method === "POST").length, 1);
      assert.strictEqual(fake.sent.filter((value) => value.method === "DELETE").length, 1);
      assert.strictEqual(fake.sent.length, 8);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "bounds reaction scans and refuses removal when the viewer record is not reached",
    () => {
      const fake = harness({
        [`GET ${base}/reactions/`]: (input: Sent) => ({
          items: [],
          next: `page_${Number(input.query.get("after")?.slice(5) ?? 0) + 1}`,
        }),
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const error = yield* api.setReaction!({ ...target, content: "heart", reacted: false }).pipe(
          Effect.flip,
        );
        assert.include(error.detail, "incomplete");
        assert.strictEqual(fake.sent.length, 11);
        assert.isTrue(fake.sent.every((value) => value.method === "GET"));
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("keeps rate-limit details safe and carries Retry-After into both adapters", () => {
    const fake = harness({
      "GET /auth/principal": new Response(
        JSON.stringify({ detail: "secret native data".repeat(200) }),
        { status: 429, headers: { "retry-after": "17" } },
      ),
    });
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.getViewer(target).pipe(Effect.flip);
      assert.strictEqual(error.detail, "GitCafe answered HTTP 429.");
      assert.strictEqual(error.reason, "rate-limited");
      assert.strictEqual(error.retryAt, now + 17_000);
      const prs = yield* GitCafePullRequestProvider.make;
      const prError = yield* prs
        .getViewer({ cwd: target.cwd, host: target.host })
        .pipe(Effect.flip);
      assert.strictEqual(prError.retryAt, error.retryAt);
      assert.strictEqual(prError.detail, error.detail);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("invalidates a rejected credential once and stops without retrying", () => {
    const fake = harness({ [`GET ${base}`]: new Response("raw private content", { status: 401 }) });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.getIssue(target).pipe(Effect.flip);
      assert.strictEqual(error.reason, "unauthenticated");
      assert.deepStrictEqual(fake.invalidated, ["git.cafe"]);
      assert.strictEqual(fake.sent.length, 1);
      assert.notInclude(error.detail, "private content");
    }).pipe(Effect.provide(fake.layer));
  });
  it.effect(
    "reads native detail, comment permissions and unknown comment count in five requests",
    () => {
      const fake = harness();
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const detail = yield* api.getIssue(target);
        assert.strictEqual(detail.key, "7");
        assert.strictEqual(detail.state.name, "triage");
        assert.strictEqual(detail.commentCount, null);
        assert.strictEqual(detail.viewer, "alice");
        assert.strictEqual(detail.comments[0]?.canEdit, true);
        assert.strictEqual(detail.commentsCursor, null);
        assert.deepStrictEqual(detail.events, []);
        assert.strictEqual(api.capabilities.templates, false);
        assert.strictEqual(api.capabilities.events, false);
        assert.deepStrictEqual(api.capabilities.involvements, ["all", "assigned", "authored"]);
        assert.deepStrictEqual(api.capabilities.listSorts, ["created", "updated"]);
        assert.strictEqual(fake.sent.length, 5);
      }).pipe(Effect.provide(fake.layer));
    },
  );
});
