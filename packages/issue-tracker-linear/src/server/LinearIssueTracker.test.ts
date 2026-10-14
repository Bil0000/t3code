import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

const user = (id: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  email: `${displayName}@acme.test`,
  avatarUrl: null,
});
const JULIUS = user("usr_julius", "julius");
const THEO = user("usr_theo", "theo");
const ORGANIZATION = { id: "org_acme", urlKey: "acme" };

const state = (name: string, type: string, position = 0) => ({
  id: `st_${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type,
  position,
});

const issue = (
  identifier: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: `iss_${identifier}`,
  identifier,
  number: Number(identifier.split("-")[1]),
  title: `Issue ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  description: "body",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  state: state("In Progress", "started"),
  creator: JULIUS,
  assignee: THEO,
  team: { key: identifier.split("-")[0] },
  labels: {
    nodes: [{ id: "lbl_bug", name: "Bug", color: "#f00" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  ...overrides,
});

/** Answers each GraphQL document by its operation name, the way Linear would. */
function fakeLinear(
  answers: Record<string, (variables: Record<string, unknown>) => unknown>,
  stored: string | null = "lin_api_stored",
) {
  let currentToken = stored;
  const requests: Array<{
    readonly authorization: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        const text =
          body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : String(body._tag);
        const parsed = JSON.parse(text) as { query: string; variables: Record<string, unknown> };
        const operation = /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
        requests.push({
          authorization: request.headers.authorization,
          operation,
          query: parsed.query,
          variables: parsed.variables,
        });
        const answer = answers[operation];
        const response =
          answer === undefined
            ? new Response(
                JSON.stringify({ errors: [{ message: `No answer for ${operation}` }] }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              )
            : (() => {
                const result = answer(parsed.variables);
                return result instanceof Response
                  ? result
                  : new Response(JSON.stringify({ data: result }), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    });
              })();
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.sync(() => Option.fromNullishOr(currentToken)) },
    }),
  );
  // Every optional write is implemented here; the type says so for the calls below.
  const dependencies = Layer.mergeAll(
    http,
    host,
    RateLimit.layer,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
        digest: (algorithm, data) =>
          Effect.promise(() =>
            globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data).buffer),
          ).pipe(Effect.map((buffer) => new Uint8Array(buffer))),
      }),
    ),
  );
  const tracker = LinearIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(LinearApi.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    tracker,
    requests,
    api: LinearApi.make.pipe(Effect.provide(dependencies)),
    setToken: (value: string) => {
      currentToken = value;
    },
  };
}

const target = { cwd: "/w/web", host: "linear.app", scope: "ENG" };

describe("LinearIssueTracker", () => {
  it.effect("rejects the same team key in another workspace without extra native reads", () =>
    Effect.gen(function* () {
      const native = issue("ENG-7", {
        url: "https://linear.app/other/issue/ENG-7",
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        reactions: [],
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
      const other = { id: "org_other", urlKey: "other" };
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issues: () => ({
          organization: other,
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3Issue: () => ({ issue: native }),
        T3IssueReference: () => ({ issue: native }),
        T3Comments: () => ({ issue: native }),
        T3CommentTarget: () => ({ issue: native, comment: { id: "comment", issue: native } }),
        T3Team: () => ({
          organization: other,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG" };
      const operations = [
        [
          api.listIssues({
            ...scoped,
            state: "all",
            involvement: "all",
            viewer: JULIUS.id,
            limit: 20,
          }),
          ["T3Issues"],
        ],
        [api.create({ ...scoped, title: "New", body: "", labels: [], assignees: [] }), ["T3Team"]],
        [api.getIssue({ ...scoped, key: "ENG-7" }), ["T3Issue", "T3Viewer"]],
        [api.getComments({ ...scoped, key: "ENG-7", cursor: "next" }), ["T3Comments", "T3Viewer"]],
        [api.comment({ ...scoped, key: "ENG-7", body: "Hello" }), ["T3IssueReference"]],
        [api.getViewerPermissions({ ...scoped, key: "ENG-7" }), ["T3IssueReference"]],
        [api.update({ ...scoped, key: "ENG-7", title: "Changed" }), ["T3IssueReference"]],
        [api.setState({ ...scoped, key: "ENG-7", state: "closed" }), ["T3IssueReference"]],
        [
          api.setReaction({ ...scoped, key: "ENG-7", content: "heart", reacted: true }),
          ["T3IssueReference"],
        ],
        [
          api.setReaction({
            ...scoped,
            key: "ENG-7",
            subjectId: "comment",
            content: "heart",
            reacted: true,
          }),
          ["T3CommentTarget"],
        ],
        [api.listCandidates(scoped), ["T3Team"]],
        [api.listTemplates(scoped), ["T3Team"]],
      ] as const;
      for (const [operation, expected] of operations) {
        test.requests.length = 0;
        expect((yield* operation.pipe(Effect.flip)).reason).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual(expected);
      }
    }),
  );
  it.effect("keeps viewer reads small and reports a partial credential catalog", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3ProbeCredential: () => ({
          organization: ORGANIZATION,
          viewer: JULIUS,
          teams: {
            nodes: [{ id: "team_eng", key: "ENG", name: "Engineering" }],
            pageInfo: { hasNextPage: true, endCursor: "more-teams" },
          },
        }),
        T3Scope: (variables) => ({
          organization: ORGANIZATION,
          teams: { nodes: [{ id: "team_hidden", key: variables.key, name: "Hidden team" }] },
        }),
      });
      const api = yield* test.tracker;
      expect(yield* api.getViewer(target)).toBe(JULIUS.id);
      expect(test.requests[0]?.query).not.toContain("teams(");
      const probe = yield* api.probeCredential("lin_api_probe");
      expect(probe.accountId).toBe(`org_acme/${JULIUS.id}`);
      expect(probe.scopesTruncated).toBe(true);
      expect(probe.scopes).toEqual([{ key: "acme/ENG", name: "Engineering" }]);
      expect(test.requests[1]?.query).toContain("teams(first: 250)");
      expect(yield* api.getScope("lin_api_probe", "hidden")).toEqual({
        key: "acme/HIDDEN",
        name: "Hidden team",
      });
      expect(yield* api.getScope("lin_api_probe", "acme/hidden")).toEqual({
        key: "acme/HIDDEN",
        name: "Hidden team",
      });
      expect(yield* api.getScope("lin_api_probe", "other/hidden")).toBeNull();
      expect(test.requests.map((request) => request.authorization)).toEqual([
        "lin_api_stored",
        "lin_api_probe",
        "lin_api_probe",
        "lin_api_probe",
        "lin_api_probe",
      ]);
    }),
  );
  it.effect("checks workspace again on the existing state query before mutation", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3TeamStates: () => ({
          organization: { id: "org_other", urlKey: "other" },
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: {
                  nodes: [state("Done", "completed")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
          },
        }),
      });
      const api = yield* test.tracker;
      const error = yield* api
        .setState({ ...target, scope: "acme/ENG", key: "ENG-7", state: "closed" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("workspace");
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3TeamStates",
      ]);
    }),
  );
  it.effect("clamps issue lists and marks partial preview labels", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Issues: () => ({
          organization: ORGANIZATION,
          issues: {
            nodes: [
              issue("ENG-1", {
                labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-labels" } },
              }),
              issue("ENG-2"),
            ],
            pageInfo: { hasNextPage: true, endCursor: "more-issues" },
          },
        }),
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 200,
      });
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.variables.first).toBe(100);
      expect(test.requests[0]?.query).toContain("labels(first: 20, includeArchived: true)");
      expect(page.items[0]?.labelsTruncated).toBe(true);
      expect(page.items.map((item) => item.commentCount)).toEqual([null, null]);
      expect(page.nextCursor).toBe("more-issues");
    }),
  );
  it.effect.each(["ENG", "acme/ENG"])(
    "writes a comment with scope %s after one small lookup",
    (scope) =>
      Effect.gen(function* () {
        const test = fakeLinear({
          T3IssueReference: () => ({
            issue: {
              id: "iss_native",
              identifier: "ENG-7",
              url: "https://linear.app/acme/issue/ENG-7",
              team: { key: "ENG" },
            },
          }),
          T3CommentCreate: (variables) => {
            expect(variables.input).toEqual({ issueId: "iss_native", body: "Comment" });
            return { commentCreate: { success: true } };
          },
        });
        const api = yield* test.tracker;
        yield* api.comment({ ...target, scope, key: "eng-7", body: "Comment" });
        expect(test.requests.map((request) => request.operation)).toEqual([
          "T3IssueReference",
          "T3CommentCreate",
        ]);
        expect(test.requests[0]?.query).not.toMatch(
          /history|attachments|comments|labels|description/u,
        );
      }),
  );
  it.effect("rejects a moved issue before a comment write", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "OTHER-7",
            url: "https://linear.app/acme/issue/OTHER-7",
            team: { key: "OTHER" },
          },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api.comment({ ...target, key: "ENG-7", body: "Comment" }).pipe(Effect.flip)).reason,
      ).toBe("failed");
      expect(test.requests.map((request) => request.operation)).toEqual(["T3IssueReference"]);
    }),
  );
  it.effect("resolves issue and comment in one small query before a reaction", () =>
    Effect.gen(function* () {
      const reference = {
        id: "iss_native",
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        team: { key: "ENG" },
      };
      const test = fakeLinear({
        T3CommentTarget: () => ({
          issue: reference,
          comment: { id: "cmt_native", issue: reference },
        }),
        T3ReactionCreate: (variables) => {
          expect(variables.input).toEqual({ commentId: "cmt_native", emoji: "👍" });
          return { reactionCreate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      yield* api.setReaction({
        ...target,
        key: "ENG-7",
        subjectId: "cmt_native",
        content: "thumbs-up",
        reacted: true,
      });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3CommentTarget",
        "T3ReactionCreate",
      ]);
      expect(test.requests[0]?.query).not.toMatch(
        /history|attachments|comments\(|labels|description/u,
      );
    }),
  );
  it.effect("cannot react to a comment on another issue or team", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3CommentTarget: () => ({
          issue: {
            id: "iss_eng",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
          comment: {
            id: "cmt_foreign",
            issue: {
              id: "iss_other",
              identifier: "OTHER-7",
              url: "https://linear.app/acme/issue/OTHER-7",
              team: { key: "OTHER" },
            },
          },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api
          .setReaction({
            ...target,
            key: "ENG-7",
            subjectId: "cmt_foreign",
            content: "thumbs-up",
            reacted: true,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("not-found");
      expect(test.requests.map((request) => request.operation)).toEqual(["T3CommentTarget"]);
    }),
  );
  it.effect("rejects foreign and moved native teams before edits or state writes", () =>
    Effect.gen(function* () {
      for (const key of ["OPS-7", "ENG-7"]) {
        const test = fakeLinear({
          T3IssueReference: () => ({
            issue: {
              id: "iss_ops",
              identifier: "OPS-7",
              url: "https://linear.app/acme/issue/OPS-7",
              team: { key: "OPS" },
            },
          }),
          T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
        });
        const api = yield* test.tracker;
        expect(
          (yield* api.update({ ...target, key, title: "Changed" }).pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(
          (yield* api.setState({ ...target, key, state: "closed" }).pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual([
          "T3IssueReference",
          "T3IssueReference",
        ]);
      }
    }),
  );
  it.effect("checks the returned native team before exposing issue or comment data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issue: () => ({
          issue: issue("OPS-7", {
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            reactions: [],
            attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
        }),
        T3Comments: () => ({
          issue: {
            id: "iss_ops",
            identifier: "OPS-7",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
        T3IssueReference: () => ({
          issue: {
            id: "iss_ops",
            identifier: "OPS-7",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
          },
        }),
      });
      const api = yield* test.tracker;
      expect((yield* api.getIssue({ ...target, key: "ENG-7" }).pipe(Effect.flip)).reason).toBe(
        "failed",
      );
      expect(
        (yield* api.getComments({ ...target, key: "ENG-7", cursor: "next" }).pipe(Effect.flip))
          .reason,
      ).toBe("failed");
      expect(
        (yield* api.getViewerPermissions({ ...target, key: "ENG-7" }).pipe(Effect.flip)).reason,
      ).toBe("failed");
    }),
  );
  it.effect("edits a moved identifier with the verified native issue UUID", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3IssueUpdate: (variables) => {
          expect(variables).toEqual({ id: "iss_native", input: { title: "Changed" } });
          return { issueUpdate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      yield* api.update({ ...target, key: "OPS-7", title: "Changed" });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3IssueUpdate",
      ]);
    }),
  );
  it.effect("rejects a mentions filter before any native request", () =>
    Effect.gen(function* () {
      const test = fakeLinear({});
      const api = yield* test.tracker;
      const error = yield* api
        .listIssues({
          ...target,
          state: "all",
          involvement: "mentioned",
          viewer: JULIUS.id,
          limit: 20,
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("mentions");
      expect(test.requests).toHaveLength(0);
    }),
  );
  it.effect("keeps full reaction counts with bounded actor names and honest detail flags", () =>
    Effect.gen(function* () {
      const nativeReactions = Array.from({ length: 100 }, (_, index) => ({
        id: `reaction-${index}`,
        emoji: "👍",
        user: user(`user-${index}`, `user-${index}`),
      }));
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issue: () => ({
          issue: issue("ENG-7", {
            labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-labels" } },
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "Comment",
                  createdAt: "2026-07-01T00:00:00.000Z",
                  url: null,
                  user: THEO,
                  reactions: nativeReactions,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            reactions: nativeReactions,
            attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            history: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-history" } },
          }),
        }),
      });
      const api = yield* test.tracker;
      const detail = yield* api.getIssue({ ...target, key: "ENG-7" });
      expect(detail.commentCount).toBe(1);
      expect(detail.labelsTruncated).toBe(true);
      expect(detail.historyTruncated).toBe(true);
      expect(detail.reactionsTruncated).toBe(true);
      expect(detail.reactions?.[0]?.count).toBe(100);
      expect(detail.reactions?.[0]?.actors).toHaveLength(20);
      expect(detail.comments[0]?.reactionsTruncated).toBe(true);
      expect(detail.comments[0]?.reactions?.[0]?.count).toBe(100);
      expect(test.requests.find((request) => request.operation === "T3Issue")?.query).toContain(
        "labels(first: 100, includeArchived: true)",
      );
      expect(test.requests.find((request) => request.operation === "T3Issue")?.query).toContain(
        "history(first: 100",
      );
    }),
  );
  it.effect("uses only exhausted native windows for the reset", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const { api } = fakeLinear({
        T3Viewer: () =>
          new Response("limited", {
            status: 429,
            headers: {
              "x-ratelimit-requests-reset": String(now + 30_000),
              "x-ratelimit-requests-remaining": "10",
              "x-ratelimit-complexity-reset": String(now + 3_600_000),
              "x-ratelimit-complexity-remaining": "10",
              "x-ratelimit-endpoint-requests-reset": String(now + 90_000),
              "x-ratelimit-endpoint-requests-remaining": "0",
              "x-ratelimit-endpoint-name": "native-viewer-limit",
              "retry-after": "5",
            },
          }),
      });
      const native = yield* api;
      const error = yield* native.viewer().pipe(Effect.flip);
      expect(error.reason).toBe("rate-limited");
      expect(error.retryAt).toBe(now + 90_000);
    }),
  );
  it.effect("keeps Retry-After separate and ignores invalid native reset times", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const { api } = fakeLinear({
        T3Viewer: () =>
          new Response("limited", {
            status: 429,
            headers: {
              "x-ratelimit-requests-reset": "not-a-timestamp",
              "x-ratelimit-complexity-reset": String(now - 1),
              "x-ratelimit-endpoint-requests-reset": "Infinity",
              "retry-after": "20",
            },
          }),
      });
      const native = yield* api;
      const error = yield* native.viewer().pipe(Effect.flip);
      expect(error.retryAt).toBe(now + 20_000);
    }),
  );
  it.effect("shares pauses across verified same-user keys and isolates another user", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      let limited = true;
      const test = fakeLinear({
        T3ProbeCredential: () => ({
          viewer: test.requests.at(-1)?.authorization === "lin_api_other" ? THEO : JULIUS,
          organization: ORGANIZATION,
          teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3Viewer: () =>
          limited
            ? new Response("limited", {
                status: 429,
                headers: {
                  "x-ratelimit-requests-reset": String(now + 60_000),
                  "x-ratelimit-requests-remaining": "0",
                },
              })
            : { viewer: test.requests.at(-1)?.authorization === "lin_api_other" ? THEO : JULIUS },
      });
      const native = yield* test.api;
      yield* native.probeCredential("lin_api_stored");
      yield* native.probeCredential("lin_api_changed");
      yield* native.viewer().pipe(Effect.flip);
      limited = false;
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(3);
      test.setToken("lin_api_changed");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(3);
      expect((yield* native.probeCredential("lin_api_unseen").pipe(Effect.flip)).reason).toBe(
        "rate-limited",
      );
      expect(test.requests).toHaveLength(4);
      yield* native.probeCredential("lin_api_other");
      test.setToken("lin_api_other");
      yield* native.viewer();
      expect(test.requests).toHaveLength(6);
      test.setToken("lin_api_stored");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(6);
      yield* TestClock.adjust("60 seconds");
      expect((yield* native.viewer()).viewer.id).toBe(JULIUS.id);
      expect(test.requests).toHaveLength(7);
    }),
  );
  it.effect("pauses a named endpoint without blocking viewer or unrelated operations", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      let limited = true;
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3CommentCreate: () => ({ commentCreate: { success: true } }),
        T3Issues: () =>
          limited
            ? Response.json(
                { errors: [{ message: "Limited", extensions: { code: "RATELIMITED" } }] },
                {
                  status: 400,
                  headers: {
                    "x-ratelimit-requests-remaining": "100",
                    "x-ratelimit-requests-reset": String(now + 3_600_000),
                    "x-ratelimit-complexity-remaining": "100",
                    "x-ratelimit-complexity-reset": String(now + 3_600_000),
                    "x-ratelimit-endpoint-requests-remaining": "0",
                    "x-ratelimit-endpoint-requests-reset": String(now + 60_000),
                    "x-ratelimit-endpoint-name": "native-issue-list-limit",
                  },
                },
              )
            : {
                organization: ORGANIZATION,
                issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
      });
      const native = yield* test.api;
      expect((yield* native.listIssues({ filter: {}, first: 20 }).pipe(Effect.flip)).retryAt).toBe(
        now + 60_000,
      );
      limited = false;
      yield* native.viewer();
      yield* native.getIssueReference("ENG-7");
      yield* native.createComment({ issueId: "iss_native", body: "Comment" });
      expect((yield* native.listIssues({ filter: {}, first: 20 }).pipe(Effect.flip)).reason).toBe(
        "rate-limited",
      );
      expect(test.requests).toHaveLength(4);
      yield* TestClock.adjust("60 seconds");
      yield* native.listIssues({ filter: {}, first: 20 });
      expect(test.requests).toHaveLength(5);
    }),
  );
  it.effect("records zero remaining quota on a successful response before another request", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json(
            { data: { viewer: JULIUS } },
            {
              headers: {
                "x-ratelimit-requests-remaining": "0",
                "x-ratelimit-requests-reset": String(now + 60_000),
                "x-ratelimit-complexity-remaining": "10",
                "x-ratelimit-complexity-reset": String(now + 3_600_000),
              },
            },
          ),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
      });
      const native = yield* test.api;
      yield* native.viewer();
      expect((yield* native.getIssueReference("ENG-7").pipe(Effect.flip)).retryAt).toBe(
        now + 60_000,
      );
      expect(test.requests).toHaveLength(1);
      yield* TestClock.adjust("60 seconds");
      yield* native.getIssueReference("ENG-7");
      expect(test.requests).toHaveLength(2);
    }),
  );
  it.effect(
    "shares a learned native endpoint across documents and keeps successful zero quotas",
    () =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        const nativeIssue = issue("ENG-7", {
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
        const headers = {
          "x-ratelimit-endpoint-name": "native-common-limit",
          "x-ratelimit-endpoint-requests-reset": String(now + 30_000),
        };
        const test = fakeLinear({
          T3Comments: () =>
            Response.json(
              { data: { issue: nativeIssue } },
              { headers: { ...headers, "x-ratelimit-endpoint-requests-remaining": "5" } },
            ),
          T3IssueReference: () =>
            Response.json(
              { data: { issue: nativeIssue } },
              { headers: { ...headers, "x-ratelimit-endpoint-requests-remaining": "0" } },
            ),
          T3Viewer: () => ({ viewer: JULIUS }),
        });
        const native = yield* test.api;
        const input = { identifier: "ENG-7", first: 50, after: "next" };
        yield* native.getComments(input);
        yield* native.getIssueReference("ENG-7");
        expect((yield* native.getComments(input).pipe(Effect.flip)).retryAt).toBe(now + 30_000);
        yield* native.viewer();
        expect((yield* native.getComments(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect(test.requests).toHaveLength(3);
        yield* TestClock.adjust("30 seconds");
        yield* native.getComments(input);
        expect(test.requests).toHaveLength(4);
      }),
  );
  it.effect.each([false, true])(
    "uses a conservative global pause when endpoint identity is missing: %s",
    (endpointOnly) =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        let limited = true;
        const pauseSeconds = endpointOnly ? 60 : 30;
        const test = fakeLinear({
          T3Viewer: () =>
            limited
              ? new Response("", {
                  status: 429,
                  headers: {
                    "x-ratelimit-requests-reset": String(now + 3_600_000),
                    ...(endpointOnly
                      ? {
                          "x-ratelimit-requests-remaining": "10",
                          "x-ratelimit-endpoint-requests-remaining": "0",
                          "x-ratelimit-endpoint-requests-reset": String(now + 60_000),
                        }
                      : {}),
                  },
                })
              : { viewer: JULIUS },
        });
        const native = yield* test.api;
        expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
        limited = false;
        expect((yield* native.viewer().pipe(Effect.flip)).retryAt).toBe(now + pauseSeconds * 1_000);
        expect(test.requests).toHaveLength(1);
        yield* TestClock.adjust(`${pauseSeconds} seconds`);
        yield* native.viewer();
        expect(test.requests).toHaveLength(2);
      }),
  );
  it.effect("records GraphQL rate limits before any later HTTP request", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json(
            { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] },
            { status: 400, headers: { "retry-after": "10" } },
          ),
      });
      const native = yield* test.api;
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(1);
    }),
  );
  it.effect("rejects GraphQL errors even with otherwise valid partial data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json({
            data: { viewer: JULIUS },
            errors: [{ message: "A field could not be read." }],
          }),
      });
      const api = yield* test.api;
      expect((yield* api.viewer().pipe(Effect.flip)).detail).toBe("A field could not be read.");
    }),
  );
  it.effect("records rate errors before decoding incomplete native data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json({
            data: { viewer: null },
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          }),
      });
      const api = yield* test.api;
      expect((yield* api.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect((yield* api.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(1);
    }),
  );
  it.effect("fails reaction removal when the viewer cannot be read", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3Viewer: () => Response.json({ errors: [{ message: "Unavailable" }] }, { status: 500 }),
        T3IssueReactions: () => ({
          issue: { reactions: [{ id: "my_reaction", emoji: "👍", user: JULIUS }] },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api
          .setReaction({ ...target, key: "ENG-7", content: "thumbs-up", reacted: false })
          .pipe(Effect.flip)).reason,
      ).toBe("failed");
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3Viewer",
      ]);
    }),
  );
  it.effect.each(["ENG", "acme/ENG"])("lists summaries with scope %s in one request", (scope) =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS, teams: { nodes: [] } }),
        T3Issues: (variables) => {
          expect(variables.filter).toMatchObject({
            team: { key: { eq: "ENG" } },
            state: { type: { nin: ["completed", "canceled"] } },
            assignee: { id: { eq: "usr_julius" } },
          });
          return {
            organization: ORGANIZATION,
            issues: {
              nodes: [
                issue("ENG-2", {
                  state: state("Done", "completed"),
                  completedAt: "2026-07-03T00:00:00.000Z",
                }),
                issue("ENG-1"),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur_2" },
            },
          };
        },
      });
      const api = yield* tracker;
      expect(api.kind).toBe(IssueTrackerKind.make("linear"));
      expect(api.standalone).toMatchObject({ host: "linear.app", scopeNoun: "team" });

      const page = yield* api.listIssues({
        ...target,
        scope,
        state: "open",
        involvement: "assigned",
        viewer: "usr_julius",
        limit: 50,
      });
      expect(page.nextCursor).toBe("cur_2");
      expect(page.items.map((item) => [item.key, item.displayKey, item.state])).toEqual([
        ["ENG-2", "ENG-2", { category: "closed", name: "Done", closeReason: "completed" }],
        ["ENG-1", "ENG-1", { category: "open", name: "In Progress" }],
      ]);
      expect(page.items[0]).toMatchObject({
        closedAt: "2026-07-03T00:00:00.000Z",
        author: { id: "usr_julius", login: "julius", name: "julius" },
        assignees: [{ id: "usr_theo", login: "theo", name: "theo" }],
        labels: [{ name: "Bug", color: "#f00" }],
      });
      // The stored key goes in as-is, not as a bearer token.
      expect(requests.map((request) => request.authorization)).toEqual(["lin_api_stored"]);
    }),
  );

  it.effect("reads an issue with its comments, reactions, history and linked pull requests", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS, teams: { nodes: [] } }),
        T3Issue: () => ({
          issue: issue("ENG-7", {
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "hi",
                  createdAt: "2026-07-02T01:00:00.000Z",
                  url: null,
                  user: THEO,
                  reactions: [{ id: "r1", emoji: "👍", user: JULIUS }],
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cmt_cur" },
            },
            reactions: [
              { id: "r2", emoji: "🚀", user: THEO },
              { id: "r3", emoji: "🚀", user: JULIUS },
              { id: "r4", emoji: "🤷", user: THEO },
            ],
            attachments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  url: "https://github.com/acme/web/pull/12",
                  title: "Fix it",
                  sourceType: "github",
                  metadata: { status: "merged" },
                },
                ...[
                  null,
                  {},
                  { status: "unknown" },
                  { status: "open" },
                  { status: "draft" },
                  { status: "closed" },
                ].map((metadata, index) => ({
                  url: `https://gitlab.com/acme/web/-/merge_requests/${index + 1}`,
                  title: `Change ${index + 1}`,
                  sourceType: "gitlab",
                  metadata,
                })),
                { url: "https://example.test/doc", title: "Doc", sourceType: null, metadata: null },
              ],
            },
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "h1",
                  createdAt: "2026-07-01T01:00:00.000Z",
                  actor: THEO,
                  fromState: state("Todo", "unstarted"),
                  toState: state("Done", "completed"),
                  fromAssignee: null,
                  toAssignee: JULIUS,
                  addedLabels: [{ id: "lbl_bug", name: "Bug", color: null }],
                  removedLabels: null,
                  fromTitle: null,
                  toTitle: null,
                },
              ],
            },
          }),
        }),
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-7" });
      expect(detail.commentCount).toBeNull();
      expect(requests.filter((request) => request.operation === "T3Issue")).toHaveLength(1);
      expect(detail.author).toMatchObject({ id: JULIUS.id, login: "julius" });
      expect(detail.assignees[0]).toMatchObject({ id: THEO.id, login: "theo" });
      expect(detail.comments[0]?.author).toMatchObject({ id: THEO.id, login: "theo" });
      expect(detail.viewer).toBe("usr_julius");
      expect(detail.commentsCursor).toBe("cmt_cur");
      expect(detail.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      ]);
      // Grouped per emoji, the viewer left out of the names; an emoji outside the vocabulary is dropped.
      expect(detail.reactions).toEqual([
        { content: "rocket", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Done"],
        ["labeled", "Bug"],
        ["assigned", "julius"],
      ]);
      expect(detail.linkedPullRequests).toEqual([
        expect.objectContaining({
          repository: "acme/web",
          provider: "github",
          host: "github.com",
          number: 12,
          state: "merged",
        }),
        ...[null, null, null, "open", "open", "closed"].map((state, index) =>
          expect.objectContaining({
            provider: "gitlab",
            host: "gitlab.com",
            repository: "acme/web",
            number: index + 1,
            title: `Change ${index + 1}`,
            url: `https://gitlab.com/acme/web/-/merge_requests/${index + 1}`,
            state,
            isDraft: index === 4,
          }),
        ),
      ]);

      const missing = yield* Effect.flip(api.getIssue({ ...target, key: "123" }));
      expect(missing.reason).toBe("not-found");
    }),
  );

  it.effect.each(["ENG", "acme/ENG"])("uses native team and member IDs with scope %s", (scope) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: {
                  nodes: [
                    user("usr_display", "  Display Name  "),
                    { ...user("usr_name", "  Full Name  "), displayName: "  " },
                    { ...user("usr_id", "  "), displayName: null },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3IssueUpdate: (variables) => {
          expect(variables).toEqual({ id: "iss_native", input: { assigneeId: "usr_display" } });
          return { issueUpdate: { success: true } };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ teamId: "team_eng", assigneeId: "usr_display" });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope };
      const candidates = yield* api.listCandidates(scoped);
      expect(candidates.assignees.map(({ id, login }) => ({ id, login }))).toEqual([
        { id: "usr_display", login: "Display Name" },
        { id: "usr_name", login: "Full Name" },
        { id: "usr_id", login: "usr_id" },
      ]);
      yield* api.update({ ...scoped, key: "ENG-7", assignees: [candidates.assignees[0]!.id] });
      yield* api.create({
        ...scoped,
        title: "New",
        body: "",
        labels: [],
        assignees: [candidates.assignees[0]!.id],
      });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3Team",
        "T3IssueReference",
        "T3Team",
        "T3IssueUpdate",
        "T3Team",
        "T3IssueCreate",
      ]);
    }),
  );
  it.effect("closes through the team's completed state and reports a missing key", () =>
    Effect.gen(function* () {
      const updates: Array<Record<string, unknown>> = [];
      const { tracker } = fakeLinear(
        {
          T3TeamStates: () => ({
            organization: ORGANIZATION,
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  states: {
                    nodes: [
                      state("Canceled", "canceled", 3),
                      state("Done", "completed", 2),
                      state("Todo", "unstarted", 1),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  templates: { nodes: [] },
                },
              ],
            },
            issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
          T3IssueUpdate: (variables) => {
            updates.push(variables);
            return { issueUpdate: { success: true } };
          },
        },
        null,
      );
      const api = yield* tracker;
      const unauthenticated = yield* Effect.flip(
        api.setState({ ...target, key: "ENG-1", state: "closed" }),
      );
      expect(unauthenticated.reason).toBe("unauthenticated");

      const connected = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-1",
            url: "https://linear.app/acme/issue/ENG-1",
            team: { key: "ENG" },
          },
        }),
        T3TeamStates: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: {
                  nodes: [
                    state("Canceled", "canceled", 3),
                    state("Done", "completed", 2),
                    state("Todo", "unstarted", 1),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3IssueUpdate: (variables) => {
          updates.push(variables);
          return { issueUpdate: { success: true } };
        },
      });
      const live = yield* connected.tracker;
      yield* live.setState({ ...target, key: "ENG-1", state: "closed", closeReason: "canceled" });
      yield* live.setState({ ...target, key: "ENG-1", state: "closed" });
      yield* live.setState({ ...target, key: "ENG-1", state: "open" });
      expect(updates.map((update) => update.input)).toEqual([
        { stateId: "st_canceled" },
        { stateId: "st_done" },
        { stateId: "st_todo" },
      ]);
      expect(connected.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
      ]);
      expect(connected.requests[1]?.query).not.toMatch(/labels|members|templates|issueLabels/u);
      expect(updates.map((update) => update.id)).toEqual([
        "iss_native",
        "iss_native",
        "iss_native",
      ]);
    }),
  );

  it("offers plain templates as drafts and form or rich ones as links into Linear", () => {
    const labels = new Map([["lbl_bug", "Bug"]]);
    const plain = LinearIssueTracker.toTemplate(
      {
        id: "tpl_1",
        name: "Bug report",
        description: "For bugs",
        content: "## Steps",
        type: "issue",
        hasFormFields: false,
        templateData: { title: "Bug: ", labelIds: ["lbl_bug", "lbl_unknown"], assigneeId: null },
      },
      "ENG",
      labels,
    );
    expect(plain).toEqual({
      template: {
        key: "tpl_1",
        name: "Bug report",
        about: "For bugs",
        title: "Bug: ",
        body: "## Steps",
        labels: ["Bug"],
        assignees: [],
      },
    });
    const form = LinearIssueTracker.toTemplate(
      {
        id: "tpl_2",
        name: "Intake",
        description: null,
        content: null,
        type: "issue",
        hasFormFields: true,
        templateData: {},
      },
      "ENG",
      labels,
    );
    expect(form).toEqual({
      link: { name: "Intake", about: "", url: "https://linear.app/team/ENG/new?template=tpl_2" },
    });
  });
});
