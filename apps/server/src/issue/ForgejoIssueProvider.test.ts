import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { assert, it } from "@effect/vitest";
import type { IssueLinkedPullRequestsPageResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoIssueProvider from "./ForgejoIssueProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reference = { cwd: "/repo", repository: "acme/web", host: "forgejo.test", number: 7 };
const rawIssue = (number = 7, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "Body",
  html_url: `https://forgejo.test/acme/web/issues/${number}`,
  user: { login: "ada" },
  state: "open",
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-02T00:00:00+00:00",
  closed_at: null,
  assignees: [{ login: "ada" }],
  labels: [{ id: 4, name: "bug", color: "ff0000" }],
  comments: 3,
  ...overrides,
});
const rawPull = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Pull ${number}`,
  html_url: `https://forgejo.test/acme/web/pulls/${number}`,
  state: "open",
  merged: false,
  draft: false,
  ...overrides,
});
const rawComment = (id = 3, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "comment",
  body: "Hello",
  user: { login: "ada" },
  created_at: "2026-10-03T00:00:00Z",
  ...overrides,
});
const repository = {
  full_name: "acme/web",
  html_url: "https://forgejo.test/acme/web",
  has_issues: true,
  created_at: "2026-09-01T00:00:00Z",
  permissions: { push: false, admin: false },
};
const baseResponse = (input: ForgejoCli.ForgejoApiInput) =>
  input.path === "user"
    ? { login: "ada" }
    : /\/(?:timeline|comments|reactions)(?:\?|$)/.test(input.path)
      ? []
      : input.path === "repos/acme/web"
        ? repository
        : rawIssue();
const providerFor = (
  api: ForgejoCli.ForgejoCli["Service"]["api"],
  target: ForgejoCli.ForgejoRepository = {
    login: "default",
    repository: "acme/web",
    baseUrl: "https://forgejo.test",
  },
) =>
  ForgejoIssueProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        SourceControlRateLimit.layer,
        Layer.mock(ForgejoCli.ForgejoCli)({
          api,
          resolveRepository: () => Effect.succeed(target),
        }),
      ),
    ),
  );

const rawPullReference = (id: number, number: number) =>
  rawComment(id, {
    type: "pull_ref",
    ref_action: "closes",
    ref_issue: {
      number,
      html_url: `https://forgejo.test/acme/web/pulls/${number}`,
      pull_request: { merged: false },
    },
  });

it.effect("rejects unsigned, tampered and foreign cursors before any host call", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const api: ForgejoCli.ForgejoCli["Service"]["api"] = (input) => {
      paths.push(input.path);
      const number = Number(input.path.split("/").at(-1));
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 6 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    };
    const provider = yield* providerFor(api);
    const second = yield* providerFor(api);
    const detail = yield* provider.getIssue(reference);
    const cursor = detail.nextLinkedPullRequestsCursor!;
    assert(cursor);
    const [payload, signature] = cursor.split(".");
    const snapshot = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    snapshot.snapshotId = "0".repeat(64);
    const forged = `${Buffer.from(JSON.stringify(snapshot)).toString("base64url")}.${signature}`;
    snapshot.kind = "events";
    snapshot.page = 1;
    const forgedSource = `${Buffer.from(JSON.stringify(snapshot)).toString("base64url")}.${signature}`;
    paths.length = 0;
    for (const input of [
      { ...reference, cursor: "garbage" },
      { ...reference, cursor: "x".repeat(16385) },
      { ...reference, cursor: forged },
      { ...reference, cursor: forgedSource },
      { ...reference, cursor, host: "other.test" },
      { ...reference, cursor, host: "forgejo.test:3000" },
      { ...reference, cursor, cwd: "/other" },
      { ...reference, cursor, repository: "git/acme/web" },
      { ...reference, cursor, number: 9 },
    ])
      assert.strictEqual(
        (yield* Effect.flip(provider.getIssueLinkedPullRequests!(input))).reason,
        "failed",
      );
    const restarted = yield* Effect.flip(
      second.getIssueLinkedPullRequests!({ ...reference, cursor }),
    );
    assert.match(restarted.detail, /Refresh/);
    yield* Effect.flip(provider.getIssueEvents!({ ...reference, cursor }));
    yield* Effect.flip(
      provider.getIssueLinkedPullRequests!({ ...reference, cursor }).pipe(
        Effect.provideService(SourceControlRateLimit.CredentialScope, "other"),
      ),
    );
    assert.deepStrictEqual(paths, []);
  }),
);

it.effect("keeps all small native event metadata complete without local pagination", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 1001 }, (_, i) => rawComment(i + 1, { type: "close" }))
              : baseResponse(input),
          ),
        ),
      );
    });
    const activity = yield* provider.getIssueActivity(reference);
    assert.strictEqual(activity.events.length, 1001);
    assert.strictEqual(activity.eventsTruncated, false);
    assert.strictEqual(activity.nextEventsCursor, null);
    assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
    assert(!paths.some((path) => path.includes("/timeline?")));
  }),
);

it.effect(
  "reads two physical overflow pages per click and never treats a private empty page as complete",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        if (input.path.endsWith("/timeline"))
          return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
        const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
        return Effect.succeed(
          processOutput(
            encodeJson(
              input.path.includes("/timeline?")
                ? page <= 4
                  ? [rawComment(page, { type: "close" })]
                  : []
                : baseResponse(input),
            ),
            {
              stderr: 'link: <https://forgejo.test/timeline?page=1>; rel="last"\nx-total-count: 0',
            },
          ),
        );
      });
      const activity = yield* provider.getIssueActivity(reference);
      assert.deepStrictEqual(
        activity.events.map((row) => row.id),
        ["1", "2"],
      );
      assert(activity.nextEventsCursor);
      const more = yield* provider.getIssueEvents!({
        ...reference,
        cursor: activity.nextEventsCursor!,
      });
      assert.deepStrictEqual(
        more.events.map((row) => row.id),
        ["3", "4"],
      );
      assert(more.nextCursor);
      const last = yield* provider.getIssueEvents!({ ...reference, cursor: more.nextCursor! });
      assert.deepStrictEqual(last.events, []);
      assert.strictEqual(last.nextCursor, null);
      assert.strictEqual(last.truncated, true);
      assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
      assert.deepStrictEqual(
        paths
          .filter((path) => path.includes("/timeline?"))
          .map((path) => Number(new URL(path, "https://forgejo.test").searchParams.get("page"))),
        [1, 2, 3, 4, 5],
      );
    }),
);

it.effect("advances denied raw PR references and deduplicates further overflow pages", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      if (input.path.endsWith("/timeline"))
        return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
      if (input.path.includes("/timeline?")) {
        const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
        const numbers =
          page === 1 ? [8, 9, 10] : page === 2 ? [11, 12, 13] : page === 3 ? [8, 14] : [];
        return Effect.succeed(
          processOutput(encodeJson(numbers.map((number) => rawPullReference(number, number)))),
        );
      }
      const number = Number(input.path.split("/").at(-1));
      if (number >= 8 && number <= 12)
        return Effect.fail(
          new ForgejoCli.ForgejoCliError({
            command: "fj",
            cwd: reference.cwd,
            reason: number % 2 ? "forbidden" : "not-found",
            detail: "Denied",
          }),
        );
      return Effect.succeed(
        processOutput(encodeJson(number >= 8 ? rawPull(number) : baseResponse(input))),
      );
    });
    const detail = yield* provider.getIssue(reference);
    assert.deepStrictEqual(detail.linkedPullRequests, []);
    assert(detail.nextLinkedPullRequestsCursor);
    const more = yield* provider.getIssueLinkedPullRequests!({
      ...reference,
      cursor: detail.nextLinkedPullRequestsCursor!,
    });
    assert.deepStrictEqual(
      more.linkedPullRequests.map((row) => [row.number, row.closesIssue]),
      [[13, false]],
    );
    assert(more.nextCursor);
    const last = yield* provider.getIssueLinkedPullRequests!({
      ...reference,
      cursor: more.nextCursor!,
    });
    assert.deepStrictEqual(
      last.linkedPullRequests.map((row) => [row.number, row.closesIssue]),
      [[14, false]],
    );
    assert.strictEqual(last.nextCursor, null);
    assert.strictEqual(last.truncated, true);
    assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
    assert.strictEqual(paths.filter((path) => path.endsWith("/pulls/8")).length, 1);
  }),
);

it.effect("records native 429 before queued PR requests and preserves Retry-After", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const retryAt = 120000;
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      if (input.path === "repos/acme/web/pulls/8")
        return Effect.fail(
          new ForgejoCli.ForgejoCliError({
            command: "fj",
            cwd: reference.cwd,
            reason: "rate-limit",
            detail: "Paused",
            retryAt,
          }),
        );
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 10 }, (_, i) => rawPullReference(i + 1, i + 8))
              : baseResponse(input),
          ),
        ),
      );
    });
    const error = yield* Effect.flip(provider.getIssue(reference));
    assert.strictEqual(error.reason, "rate-limited");
    assert.strictEqual(error.retryAt, retryAt);
    assert(!paths.some((path) => /\/pulls\/(?:1[0-2])$/.test(path)));
    paths.length = 0;
    const paused = yield* Effect.flip(provider.getIssueSummary!(reference));
    assert.strictEqual(paused.retryAt, retryAt);
    assert.deepStrictEqual(paths, []);
    yield* provider.getIssueSummary!(reference).pipe(
      Effect.provideService(SourceControlRateLimit.CredentialScope, "other"),
    );
    assert.deepStrictEqual(paths, ["repos/acme/web/issues/7"]);
  }),
);

it.effect("fetches five PRs with exactly two concurrent permission reads", () =>
  Effect.gen(function* () {
    let active = 0;
    let peak = 0;
    const provider = yield* providerFor((input) =>
      Effect.gen(function* () {
        const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
        if (number >= 8) {
          active++;
          peak = Math.max(peak, active);
          yield* Effect.yieldNow;
          active--;
          return processOutput(encodeJson(rawPull(number)));
        }
        return processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 10 }, (_, i) => rawPullReference(i + 1, i + 8))
              : baseResponse(input),
          ),
        );
      }),
    );
    const detail = yield* provider.getIssue(reference);
    assert.strictEqual(detail.linkedPullRequests.length, 5);
    assert.strictEqual(peak, 2);
    peak = 0;
    const more = yield* provider.getIssueLinkedPullRequests!({
      ...reference,
      cursor: detail.nextLinkedPullRequestsCursor!,
    });
    assert.strictEqual(more.linkedPullRequests.length, 5);
    assert.strictEqual(more.truncated, false);
    assert.strictEqual(peak, 2);
  }),
);

it.effect("keeps all 800 linked PRs reachable with small cursors and bounded fresh reads", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      const number = Number(input.path.split("/").at(-1));
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 800 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    });
    const detail = yield* provider.getIssue(reference);
    assert.strictEqual(detail.linkedPullRequestsTruncated, true);
    let cursor: string | null | undefined = detail.nextLinkedPullRequestsCursor;
    assert(cursor);
    const numbers = detail.linkedPullRequests.map((row) => row.number);
    while (cursor) {
      assert(cursor.length < 256);
      const before = paths.length;
      const page: IssueLinkedPullRequestsPageResult = yield* provider.getIssueLinkedPullRequests!({
        ...reference,
        cursor,
      });
      assert.strictEqual(page.truncated, page.nextCursor !== null);
      assert.strictEqual(paths.length - before, 5);
      numbers.push(...page.linkedPullRequests.map((row) => row.number));
      cursor = page.nextCursor;
    }
    assert.deepStrictEqual(
      numbers,
      Array.from({ length: 800 }, (_, i) => i + 8),
    );
    assert.strictEqual(new Set(numbers).size, numbers.length);
    assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
  }),
);

it.effect("retains physical continuation and all 800 overflow references", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      assert(input.method === undefined || input.method === "GET");
      if (input.path.endsWith("/timeline"))
        return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
      const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
      const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.includes("/timeline?")
              ? page <= 16
                ? Array.from({ length: 50 }, (_, i) => {
                    const number = (page - 1) * 50 + i + 8;
                    return rawPullReference(number, number);
                  })
                : []
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    });
    const detail = yield* provider.getIssue(reference);
    const numbers = detail.linkedPullRequests.map((row) => row.number);
    let cursor = detail.nextLinkedPullRequestsCursor;
    while (cursor) {
      assert(cursor.length < 256);
      paths.length = 0;
      const result = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor });
      assert.strictEqual(result.truncated, true);
      assert(paths.filter((path) => /\/pulls\/\d+$/.test(path)).length <= 5);
      assert(paths.filter((path) => path.includes("/timeline?")).length <= 2);
      assert(!paths.some((path) => path.endsWith("/timeline")));
      numbers.push(...result.linkedPullRequests.map((row) => row.number));
      cursor = result.nextCursor;
    }
    assert.deepStrictEqual(
      numbers,
      Array.from({ length: 800 }, (_, i) => i + 8),
    );
    assert.deepStrictEqual(paths, ["repos/acme/web/issues/7/timeline?limit=50&page=17"]);
  }),
);

it.effect("expires old snapshots after 15 minutes without extending their lifetime on reads", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 12 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    });
    const detail = yield* provider.getIssue(reference);
    const cursor = detail.nextLinkedPullRequestsCursor!;
    yield* TestClock.adjust("14 minutes");
    const next = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor });
    assert(next.nextCursor);
    yield* TestClock.adjust(60_001);
    paths.length = 0;
    const error = yield* Effect.flip(
      provider.getIssueLinkedPullRequests!({ ...reference, cursor }),
    );
    assert.strictEqual(error.reason, "failed");
    assert.match(error.detail, /expired.*Refresh/);
    assert.deepStrictEqual(paths, []);
    const last = yield* provider.getIssueLinkedPullRequests!({
      ...reference,
      cursor: next.nextCursor!,
    });
    assert.deepStrictEqual(
      last.linkedPullRequests.map((row) => row.number),
      [18, 19],
    );
    assert.strictEqual(last.truncated, false);
  }),
);

it.effect("reuses unchanged detail snapshots and renews their lifetime at minute 14", () =>
  Effect.gen(function* () {
    const provider = yield* providerFor((input) => {
      const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 6 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    });
    const otherIssue = { ...reference, number: 8 };
    const other = yield* provider.getIssue(otherIssue);
    const first = yield* provider.getIssue(reference);
    const cursor = first.nextLinkedPullRequestsCursor!;
    assert.notStrictEqual(other.nextLinkedPullRequestsCursor, cursor);
    assert.strictEqual(other.nextLinkedPullRequestsCursor!.split(".")[0], cursor.split(".")[0]);
    for (let i = 0; i < 65; i++) {
      const detail = yield* provider.getIssue(reference);
      assert.strictEqual(detail.nextLinkedPullRequestsCursor, cursor);
    }
    const unrelated = yield* provider.getIssueLinkedPullRequests!({
      ...otherIssue,
      cursor: other.nextLinkedPullRequestsCursor!,
    });
    assert.deepStrictEqual(
      unrelated.linkedPullRequests.map((row) => row.number),
      [13],
    );
    yield* TestClock.adjust("14 minutes");
    const refreshed = yield* provider.getIssue(reference);
    assert.strictEqual(refreshed.nextLinkedPullRequestsCursor, cursor);
    yield* TestClock.adjust("2 minutes");
    const continued = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor });
    assert.deepStrictEqual(
      continued.linkedPullRequests.map((row) => row.number),
      [13],
    );
    assert.strictEqual(continued.truncated, false);
    yield* TestClock.adjust(13 * 60_000 + 1);
    const expired = yield* Effect.flip(
      provider.getIssueLinkedPullRequests!({ ...reference, cursor }),
    );
    assert.match(expired.detail, /expired.*Refresh/);
  }),
);

it.effect("evicts snapshots beyond capacity 64 and requires refresh without native reads", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
      return Effect.succeed(
        processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 6 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        ),
      );
    });
    const cursors: string[] = [];
    for (let i = 0; i < 64; i++) {
      const detail = yield* provider.getIssue({ ...reference, number: i + 7 });
      cursors.push(detail.nextLinkedPullRequestsCursor!);
    }
    const before = yield* provider.getIssueLinkedPullRequests!({
      ...reference,
      cursor: cursors[0]!,
    });
    assert.deepStrictEqual(
      before.linkedPullRequests.map((row) => row.number),
      [13],
    );
    const refreshed = yield* provider.getIssue({ ...reference, number: 71 });
    paths.length = 0;
    for (let i = 0; i < 20; i++) {
      const error = yield* Effect.flip(
        provider.getIssueLinkedPullRequests!({ ...reference, number: 8, cursor: cursors[1]! }),
      );
      assert.match(error.detail, /expired.*Refresh/);
    }
    assert.deepStrictEqual(paths, []);
    for (const number of [7, ...Array.from({ length: 63 }, (_, i) => i + 9)]) {
      const cursor = number === 71 ? refreshed.nextLinkedPullRequestsCursor! : cursors[number - 7]!;
      const current = yield* provider.getIssueLinkedPullRequests!({ ...reference, number, cursor });
      assert.deepStrictEqual(
        current.linkedPullRequests.map((row) => row.number),
        [13],
      );
      assert.strictEqual(current.truncated, false);
    }
  }),
);

it.effect("replays immutable snapshots and lets concurrent walks advance independently", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) =>
      Effect.gen(function* () {
        paths.push(input.path);
        assert(input.method === undefined || input.method === "GET");
        yield* Effect.yieldNow;
        const number = Number(/\/pulls\/(\d+)$/.exec(input.path)?.[1]);
        return processOutput(
          encodeJson(
            input.path.endsWith("/timeline")
              ? Array.from({ length: 20 }, (_, i) => rawPullReference(i + 1, i + 8))
              : number >= 8
                ? rawPull(number)
                : baseResponse(input),
          ),
        );
      }),
    );
    const detail = yield* provider.getIssue(reference);
    const cursor = detail.nextLinkedPullRequestsCursor!;
    paths.length = 0;
    const [first, second] = yield* Effect.all(
      [
        provider.getIssueLinkedPullRequests!({ ...reference, cursor }),
        provider.getIssueLinkedPullRequests!({ ...reference, cursor }),
      ],
      { concurrency: 2 },
    );
    assert.deepStrictEqual(first.linkedPullRequests, second.linkedPullRequests);
    assert.strictEqual(first.nextCursor, second.nextCursor);
    const replay = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor });
    assert.deepStrictEqual(replay.linkedPullRequests, first.linkedPullRequests);
    assert.strictEqual(replay.nextCursor, first.nextCursor);
    for (const start of [first, second]) {
      const numbers = start.linkedPullRequests.map((row) => row.number);
      let next = start.nextCursor;
      while (next) {
        const result = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor: next });
        assert.strictEqual(result.truncated, result.nextCursor !== null);
        numbers.push(...result.linkedPullRequests.map((row) => row.number));
        next = result.nextCursor;
      }
      assert.deepStrictEqual(
        numbers,
        Array.from({ length: 15 }, (_, i) => i + 13),
      );
    }
    assert.strictEqual(paths.length, 35);
    assert(paths.every((path) => /\/pulls\/\d+$/.test(path)));
  }),
);

it.effect("stops overflow at a private empty first page without claiming complete", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      if (input.path.endsWith("/timeline"))
        return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
      return Effect.succeed(
        processOutput(encodeJson(baseResponse(input)), {
          stderr: input.path.includes("/timeline?")
            ? 'link: <https://forgejo.test/timeline?page=2>; rel="next"\nx-total-count: 100'
            : "",
        }),
      );
    });
    const detail = yield* provider.getIssue(reference);
    assert.strictEqual(detail.linkedPullRequestsTruncated, true);
    assert.strictEqual(detail.nextLinkedPullRequestsCursor, null);
    const activity = yield* provider.getIssueActivity(reference);
    assert.strictEqual(activity.eventsTruncated, true);
    assert.strictEqual(activity.nextEventsCursor, null);
    assert.strictEqual(paths.filter((path) => path.includes("/timeline?")).length, 2);
    assert(!paths.some((path) => path.includes("page=2")));
  }),
);

const issueListOutput = (
  input: ForgejoCli.ForgejoApiInput,
  rows: ReadonlyArray<ReturnType<typeof rawIssue>>,
  size = 50,
) => {
  const params = new URL(input.path, "https://forgejo.test").searchParams;
  const seconds = (date: string) => Math.floor(Date.parse(date) / 1000);
  const before = params.get("before");
  const since = params.get("since");
  const remaining = rows.filter(
    (issue) =>
      (!before || seconds(issue.updated_at) <= seconds(before)) &&
      (!since || seconds(issue.updated_at) >= seconds(since)),
  );
  const page = Number(params.get("page"));
  const last = Math.max(1, Math.ceil(remaining.length / size));
  return processOutput(encodeJson(remaining.slice((page - 1) * size, page * size)), {
    stderr: `link: <https://forgejo.test/issues?page=${last}>; rel="last"${page < last ? ', <https://forgejo.test/issues?page=2>; rel="next"' : ""}\nx-total-count: ${remaining.length}`,
  });
};

it.effect("sorts complete time windows and honors a server's smaller page cap", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-04T00:00:00Z"));
    const paths: string[] = [];
    const rows = [
      rawIssue(8, { created_at: "2026-10-03T00:00:00Z" }),
      rawIssue(7, { updated_at: "2026-10-04T00:00:00Z" }),
    ];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      assert.strictEqual(input.host, reference.host);
      assert.strictEqual(input.repository, reference.repository);
      return Effect.succeed(
        input.path.includes("?")
          ? issueListOutput(input, rows, 1)
          : processOutput(encodeJson(repository)),
      );
    });
    const input = {
      ...reference,
      state: "all" as const,
      involvement: "assigned" as const,
      viewer: "ada",
      limit: 1,
      query: "hello & bye",
    };
    const updated = yield* provider.listIssues(input);
    assert.deepStrictEqual(
      updated.items.map((issue) => issue.number),
      [7],
    );
    assert.strictEqual(updated.items[0]?.updatedAt, "2026-10-04T00:00:00.000Z");
    assert.strictEqual(updated.truncated, true);
    assert.strictEqual(updated.continues, true);
    const query = new URL(paths[1]!, "https://forgejo.test").searchParams;
    assert.strictEqual(query.get("type"), "issues");
    assert.strictEqual(query.get("assigned_by"), "ada");
    assert.strictEqual(query.get("q"), "hello & bye");
    assert.strictEqual(query.get("sort"), "latest");
    const created = yield* provider.listIssues({
      ...input,
      sort: "created",
      order: "asc",
      limit: 2,
    });
    assert.deepStrictEqual(
      created.items.map((issue) => issue.number),
      [7, 8],
    );
  }),
);

it.effect("reads created order from either end without scanning all native pages", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 1055 }, (_, i) =>
      rawIssue(1055 - i, {
        created_at: DateTime.formatIso(
          DateTime.makeUnsafe(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T00:00:00Z")) + (1055 - i) * 1000,
          ),
        ),
      }),
    );
    for (const order of ["asc", "desc"] as const) {
      const pages: number[] = [];
      const provider = yield* providerFor((input) => {
        if (!input.path.includes("?")) return Effect.succeed(processOutput(encodeJson(repository)));
        const params = new URL(input.path, "https://forgejo.test").searchParams;
        assert.strictEqual(params.get("sort"), "latest");
        pages.push(Number(params.get("page")));
        return Effect.succeed(issueListOutput(input, rows));
      });
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        sort: "created",
        order,
        limit: 20,
      });
      assert.deepStrictEqual(
        result.items.map((issue) => issue.number),
        Array.from({ length: 20 }, (_, i) => (order === "asc" ? i + 1 : 1055 - i)),
      );
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.continues, false);
      assert.deepStrictEqual(pages, order === "asc" ? [1, 22, 21] : [1]);
    }
  }),
);

it.effect("stops issue paging when Link has no next page and excludes pull requests", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
    const provider = yield* providerFor((input) =>
      Effect.succeed(
        processOutput(
          encodeJson(
            input.path.includes("?")
              ? [rawIssue(), rawIssue(8, { pull_request: { merged: false } })]
              : repository,
          ),
          {
            stderr: 'link: <https://forgejo.test/api/v1/repos/acme/web/issues?page=1>; rel="last"',
          },
        ),
      ),
    );
    const page = yield* provider.listIssues({
      ...reference,
      state: "open",
      involvement: "all",
      viewer: "ada",
      limit: 20,
    });
    assert.deepStrictEqual(
      page.items.map((issue) => issue.number),
      [7],
    );
    assert.strictEqual(page.truncated, false);
  }),
);

it.effect("reads an issue summary without fetching activity or permissions", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      return Effect.succeed(processOutput(encodeJson(rawIssue())));
    });
    const summary = yield* provider.getIssueSummary!(reference);
    assert.strictEqual(summary.title, "Issue 7");
    assert.deepStrictEqual(paths, ["repos/acme/web/issues/7"]);
  }),
);

it.effect("restricts writes for other authors, locked issues and archived repositories", () =>
  Effect.gen(function* () {
    for (const [viewer, push, locked, archived, canEdit, canComment] of [
      ["ada", false, false, false, true, true],
      ["bob", false, true, false, false, false],
      ["bob", true, true, false, true, true],
      ["ada", true, false, true, false, false],
    ] as const) {
      const provider = yield* providerFor((input) =>
        Effect.succeed(
          processOutput(
            encodeJson(
              input.path === "user"
                ? { login: viewer }
                : input.path === "repos/acme/web"
                  ? { ...repository, archived, permissions: { push, admin: push } }
                  : input.path.endsWith("/timeline")
                    ? []
                    : rawIssue(7, { is_locked: locked }),
            ),
          ),
        ),
      );
      const detail = yield* provider.getIssue(reference);
      const permissions = yield* provider.getViewerPermissions(reference);
      assert.deepStrictEqual(detail.viewerPermissions, permissions);
      assert.strictEqual(permissions.edit, canEdit);
      assert.strictEqual(permissions.comment, canComment);
      assert.strictEqual(permissions.labels, push && !archived);
      assert.strictEqual(permissions.assignees, push && !archived);
      assert.deepStrictEqual(permissions.actions, canEdit ? ["close", "reopen"] : []);
    }
  }),
);

it.effect(
  "reads the full native timeline once for comments and events and discovers later PRs",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const timeline = [
        rawComment(),
        rawComment(4, { type: "close" }),
        rawComment(5, { type: "assignees", assignee: { login: "bob" }, removed_assignee: true }),
        rawComment(6, { type: "new_unknown_kind" }),
        rawComment(7, { type: "label", body: "1", label: { id: 4, name: "bug" } }),
        rawComment(8, { type: "label", body: "", label: { id: 4, name: "bug" } }),
        null,
        ...Array.from({ length: 50 }, (_, i) => rawComment(9 + i, { type: "new_unknown_kind" })),
        rawComment(1000003),
        rawComment(1000004, {
          type: "pull_ref",
          ref_action: "closes",
          ref_issue: {
            number: 8,
            html_url: "https://forgejo.test/acme/web/pulls/8",
            pull_request: { merged: false },
          },
        }),
      ];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        const response = input.path.endsWith("/timeline")
          ? timeline
          : input.path.endsWith("/pulls/8")
            ? rawPull(8)
            : baseResponse(input);
        return Effect.succeed(
          processOutput(encodeJson(response), {
            stderr: input.path.endsWith("/timeline") ? `x-total-count: ${timeline.length}` : "",
          }),
        );
      });
      const activity = yield* provider.getIssueActivity(reference);
      assert.deepStrictEqual(
        activity.comments.map((row) => row.id),
        ["3", "1000003"],
      );
      assert.strictEqual(activity.commentCount, 3);
      assert.strictEqual(activity.commentsTruncated, false);
      assert.strictEqual(activity.nextCommentsCursor, null);
      assert.strictEqual(activity.eventsTruncated, false);
      assert.deepStrictEqual(
        activity.events.map((row) => [row.kind, row.detail]),
        [
          ["closed", null],
          ["unassigned", "bob"],
          ["labeled", "bug"],
          ["unlabeled", "bug"],
          ["referenced", null],
        ],
      );
      assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
      assert(!paths.some((path) => path.endsWith("/comments") || path.includes("/timeline?")));
      const detail = yield* provider.getIssue(reference);
      assert.deepStrictEqual(
        detail.linkedPullRequests.map((pull) => [pull.number, pull.closesIssue]),
        [[8, true]],
      );
      assert.strictEqual(detail.linkedPullRequestsTruncated, false);
      assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 2);
    }),
);

it.effect(
  "pages 50 comments by time and ID across offsets and deleted earlier and cursor rows",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let comments = Array.from({ length: 105 }, (_, i) =>
        rawComment(1000105 - i, {
          created_at: DateTime.formatIso(
            DateTime.makeUnsafe(
              Date.parse("2026-10-03T00:00:00Z") + Math.floor(i / 3) * 1000 + (i % 2 ? 3600000 : 0),
            ),
          ).replace("Z", i % 2 ? "+01:00" : "Z"),
        }),
      );
      const expected = [...comments].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id,
      );
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        return Effect.succeed(
          processOutput(
            encodeJson(
              input.path.endsWith("/timeline") || input.path.endsWith("/comments")
                ? comments
                : baseResponse(input),
            ),
          ),
        );
      });
      const activity = yield* provider.getIssueActivity(reference);
      assert.deepStrictEqual(
        activity.comments.map((row) => row.id),
        expected.slice(0, 50).map((row) => String(row.id)),
      );
      assert.strictEqual(activity.commentsTruncated, true);
      assert.strictEqual(paths.filter((path) => path.includes("/issues/comments/")).length, 50);
      assert(activity.nextCommentsCursor);
      for (const value of [
        "2",
        "../../other",
        {},
        [],
        ["2026-10-03T00:00:00.000Z"],
        ["2026-10-03T00:00:00.000Z", 3, "extra"],
        ["invalid", 3],
        ["2026-02-30T00:00:00.000Z", 3],
        ["2026-10-03", 3],
        ["2026-10-03T00:00:00.000Z", 0],
        ["2026-10-03T00:00:00.000Z", -1],
        ["2026-10-03T00:00:00.000Z", 1.5],
        ["2026-10-03T00:00:00.000Z", Number.MAX_SAFE_INTEGER + 1],
        ["2026-10-03T00:00:00.000Z", "3"],
      ]) {
        const before = paths.length;
        const cursor =
          typeof value === "string" ? value : Buffer.from(encodeJson(value)).toString("base64url");
        assert.strictEqual(
          (yield* Effect.flip(provider.getIssueComments!({ ...reference, cursor }))).reason,
          "failed",
        );
        assert.strictEqual(paths.length, before);
      }
      comments = comments.filter(
        (row) => row.id !== expected[0]!.id && row.id !== expected[49]!.id,
      );
      const next = yield* provider.getIssueComments!({
        ...reference,
        cursor: activity.nextCommentsCursor,
      });
      assert.deepStrictEqual(
        next.comments.map((row) => row.id),
        expected.slice(50, 100).map((row) => String(row.id)),
      );
      assert(next.nextCursor);
      const last = yield* provider.getIssueComments!({ ...reference, cursor: next.nextCursor });
      assert.deepStrictEqual(
        last.comments.map((row) => row.id),
        expected.slice(100).map((row) => String(row.id)),
      );
      assert.strictEqual(last.nextCursor, null);
      assert.strictEqual(paths.filter((path) => path.includes("/issues/comments/")).length, 105);
      assert.strictEqual(paths.filter((path) => path.endsWith("/comments")).length, 2);
      assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
      assert(!paths.some((path) => path.includes("/comments?")));
    }),
);

it.effect(
  "keeps plain comments and body readable after oversized timelines with hidden empty native pages",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        if (input.path.endsWith("/timeline"))
          return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
        if (input.path.includes("/timeline?")) {
          const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
          assert(page <= 2);
          const rows =
            page === 1
              ? [
                  rawComment(4, { type: "close" }),
                  rawComment(5, {
                    type: "pull_ref",
                    ref_action: "closes",
                    ref_issue: {
                      number: 8,
                      html_url: "https://forgejo.test/acme/web/pulls/8",
                      pull_request: { merged: false },
                    },
                  }),
                ]
              : null;
          return Effect.succeed(
            processOutput(encodeJson(rows), { stderr: `x-total-count: ${rows?.length ?? 0}` }),
          );
        }
        return Effect.succeed(
          processOutput(
            encodeJson(
              input.path.endsWith("/comments")
                ? [rawComment(1000003)]
                : input.path.endsWith("/pulls/8")
                  ? rawPull(8)
                  : baseResponse(input),
            ),
          ),
        );
      });
      const activity = yield* provider.getIssueActivity(reference);
      assert.deepStrictEqual(
        activity.comments.map((row) => [row.id, row.body]),
        [["1000003", "Hello"]],
      );
      assert.strictEqual(activity.commentsTruncated, false);
      assert.strictEqual(activity.nextCommentsCursor, null);
      assert.strictEqual(activity.eventsTruncated, true);
      assert.deepStrictEqual(
        activity.events.map((row) => row.kind),
        ["closed", "referenced"],
      );
      const detail = yield* provider.getIssue(reference);
      assert.strictEqual(detail.body, "Body");
      assert.strictEqual(detail.linkedPullRequestsTruncated, true);
      assert.deepStrictEqual(
        detail.linkedPullRequests.map((pull) => [pull.number, pull.closesIssue]),
        [[8, false]],
      );
      assert.deepStrictEqual(
        paths
          .filter((path) => path.includes("/timeline?"))
          .map((path) => Number(new URL(path, "https://forgejo.test").searchParams.get("page"))),
        [1, 2, 1, 2],
      );
      assert.strictEqual(paths.filter((path) => path.endsWith("/comments")).length, 1);
    }),
);

it.effect("marks complete empty native timelines complete with one GET per read", () =>
  Effect.gen(function* () {
    for (const rows of [null, []]) {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        return Effect.succeed(
          processOutput(encodeJson(input.path.endsWith("/timeline") ? rows : baseResponse(input)), {
            stderr: "x-total-count: 0",
          }),
        );
      });
      const activity = yield* provider.getIssueActivity(reference);
      assert.deepStrictEqual(activity.comments, []);
      assert.strictEqual(activity.commentsTruncated, false);
      assert.strictEqual(activity.nextCommentsCursor, null);
      assert.strictEqual(activity.eventsTruncated, false);
      assert.deepStrictEqual(activity.events, []);
      const detail = yield* provider.getIssue(reference);
      assert.deepStrictEqual(detail.linkedPullRequests, []);
      assert.strictEqual(detail.linkedPullRequestsTruncated, false);
      assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 2);
      assert(!paths.some((path) => path.includes("/timeline?") || path.endsWith("/comments")));
    }
  }),
);

it.effect(
  "maps label names to ids and clears labels and assignees without losing other fields",
  () =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const provider = yield* providerFor((input) => {
        if (input.method) writes.push(input);
        return Effect.succeed(
          processOutput(
            encodeJson(
              input.path.startsWith("orgs/")
                ? []
                : input.path.includes("/labels?")
                  ? [{ id: 4, name: "bug" }]
                  : rawIssue(),
            ),
            { stderr: 'link: <https://forgejo.test/labels?page=1>; rel="last"' },
          ),
        );
      });
      yield* provider.setLabels({ ...reference, labels: ["bug"] });
      yield* provider.setLabels({ ...reference, labels: [] });
      yield* provider.setAssignees({ ...reference, assignees: [] });
      yield* provider.update({ ...reference, body: "" });
      yield* provider.runAction({ ...reference, action: "close" });
      assert.deepStrictEqual(
        writes.map((write) => [write.method, write.body]),
        [
          ["PUT", { labels: [4] }],
          ["PUT", { labels: [] }],
          ["PATCH", { assignees: [] }],
          ["PATCH", { body: "" }],
          ["PATCH", { state: "closed" }],
        ],
      );
      assert.strictEqual(
        (yield* Effect.flip(provider.setLabels({ ...reference, labels: ["missing"] }))).reason,
        "failed",
      );
      assert.strictEqual(writes.length, 5);
    }),
);

it.effect("creates issues and reads label and assignee candidates using provider identifiers", () =>
  Effect.gen(function* () {
    const writes: ForgejoCli.ForgejoApiInput[] = [];
    const provider = yield* providerFor((input) => {
      if (input.method) writes.push(input);
      const response = input.path.startsWith("orgs/")
        ? []
        : input.path.includes("/labels?")
          ? [{ id: 4, name: "bug", description: "A bug" }]
          : input.path.includes("/assignees?")
            ? [{ login: "ada" }, { login: "bob" }]
            : rawIssue();
      return Effect.succeed(
        processOutput(encodeJson(response), {
          stderr: 'link: <https://forgejo.test/page=1>; rel="last"',
        }),
      );
    });
    const created = yield* provider.create({
      ...reference,
      title: "New",
      body: "Text",
      labels: ["bug"],
      assignees: ["ada"],
    });
    assert.deepStrictEqual(created, { number: 7, url: rawIssue().html_url });
    assert.deepStrictEqual(writes[0]?.body, {
      title: "New",
      body: "Text",
      labels: [4],
      assignees: ["ada"],
    });
    const labels = yield* provider.listLabelCandidates(reference);
    assert.strictEqual(labels.candidates[0]?.isApplied, true);
    const assignees = yield* provider.listAssigneeCandidates(reference);
    assert.deepStrictEqual(
      assignees.candidates.map((assignee) => [assignee.id, assignee.isAssigned]),
      [
        ["ada", true],
        ["bob", false],
      ],
    );
  }),
);

it.effect(
  "keeps organization labels available and prefers a repository label with the same name",
  () =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const provider = yield* providerFor((input) => {
        if (input.method) writes.push(input);
        const response = input.path.startsWith("orgs/")
          ? [
              { id: 8, name: "org-label" },
              { id: 9, name: "bug" },
            ]
          : input.path.includes("/labels?")
            ? [{ id: 4, name: "bug" }]
            : rawIssue();
        return Effect.succeed(
          processOutput(encodeJson(response), {
            stderr: 'link: <https://forgejo.test/page=1>; rel="last"',
          }),
        );
      });
      const labels = yield* provider.listLabelCandidates(reference);
      assert.deepStrictEqual(
        labels.candidates.map((label) => label.name),
        ["org-label", "bug"],
      );
      yield* provider.setLabels({ ...reference, labels: ["org-label", "bug"] });
      assert.deepStrictEqual(writes[0]?.body, { labels: [8, 4] });
    }),
);

it.effect(
  "ignores a missing organization without hiding authentication or rate limit failures",
  () =>
    Effect.gen(function* () {
      for (const reason of ["not-found", "authentication", "rate-limit"] as const) {
        let writes = 0;
        const provider = yield* providerFor((input) => {
          if (input.method) writes++;
          if (input.path.startsWith("orgs/"))
            return Effect.fail(
              new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/repo",
                reason,
                detail: "Organization labels failed",
              }),
            );
          return Effect.succeed(
            processOutput(encodeJson([{ id: 4, name: "bug" }]), {
              stderr: 'link: <https://forgejo.test/page=1>; rel="last"',
            }),
          );
        });
        const write = provider.setLabels({ ...reference, labels: ["bug"] });
        if (reason === "not-found") {
          yield* write;
          assert.strictEqual(writes, 1);
        } else {
          assert.strictEqual(
            (yield* Effect.flip(write)).reason,
            reason === "rate-limit" ? "rate-limited" : "unauthenticated",
          );
          assert.strictEqual(writes, 0);
        }
      }
    }),
);

it.effect("refuses to edit a comment outside the requested issue or host", () =>
  Effect.gen(function* () {
    for (const url of [
      "https://forgejo.test/api/v1/repos/acme/web/issues/8",
      "https://other.test/api/v1/repos/acme/web/issues/7",
      "invalid URL",
    ]) {
      let writes = 0;
      const provider = yield* providerFor((input) => {
        if (input.method) writes++;
        return Effect.succeed(
          processOutput(
            encodeJson({
              id: 3,
              body: "Before",
              user: { login: "ada" },
              created_at: "2026-10-03T00:00:00Z",
              issue_url: url,
            }),
          ),
        );
      });
      assert.strictEqual(
        (yield* Effect.flip(
          provider.updateComment!({ ...reference, commentId: "3", body: "After" }),
        )).reason,
        "failed",
      );
      assert.strictEqual(writes, 0);
    }
  }),
);

it.effect("edits a comment from the requested issue on an installation with a URL prefix", () =>
  Effect.gen(function* () {
    const writes: ForgejoCli.ForgejoApiInput[] = [];
    const provider = yield* providerFor(
      (input) => {
        if (input.method) writes.push(input);
        return Effect.succeed(
          processOutput(
            encodeJson({
              id: 3,
              body: "Before",
              user: { login: "ada" },
              created_at: "2026-10-03T00:00:00Z",
              issue_url: "https://forgejo.test/git/api/v1/repos/acme/web/issues/7",
            }),
          ),
        );
      },
      { login: "default", repository: "acme/web", baseUrl: "https://forgejo.test/git" },
    );
    yield* provider.updateComment!({
      ...reference,
      repository: "git/acme/web",
      commentId: "3",
      body: "After",
    });
    assert.strictEqual(writes[0]?.path, "repos/git/acme/web/issues/comments/3");
    assert.deepStrictEqual(writes[0]?.body, { body: "After" });
  }),
);

it.effect("reads organization labels using the owner below a server URL prefix", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor(
      (input) => {
        paths.push(input.path);
        return Effect.succeed(
          processOutput(
            encodeJson(
              input.path.startsWith("orgs/acme/")
                ? [{ id: 8, name: "team" }]
                : input.path.includes("/labels?")
                  ? []
                  : rawIssue(7, { labels: [{ id: 8, name: "team" }] }),
            ),
            { stderr: 'link: <https://forgejo.test/git/page=1>; rel="last"' },
          ),
        );
      },
      { login: "default", repository: "acme/web", baseUrl: "https://forgejo.test/git" },
    );
    const result = yield* provider.listLabelCandidates({
      ...reference,
      repository: "git/acme/web",
    });
    assert.strictEqual(result.candidates[0]?.name, "team");
    assert.strictEqual(result.candidates[0]?.isApplied, true);
    assert(paths.includes("orgs/acme/labels?limit=50&page=1"));
  }),
);

it.effect("preserves failure categories and never decodes truncated responses", () =>
  Effect.gen(function* () {
    for (const [reason, expected] of [
      ["missing-cli", "missing-tool"],
      ["authentication", "unauthenticated"],
      ["rate-limit", "rate-limited"],
      ["not-found", "failed"],
    ] as const) {
      const provider = yield* providerFor(() =>
        Effect.fail(
          new ForgejoCli.ForgejoCliError({
            command: "tea",
            cwd: "/repo",
            reason,
            detail: "Failure",
          }),
        ),
      );
      assert.strictEqual(
        (yield* Effect.flip(provider.getIssueSummary!(reference))).reason,
        expected,
      );
    }
    for (const response of [
      processOutput("invalid JSON"),
      { ...processOutput(encodeJson(rawIssue())), stdoutTruncated: true },
    ]) {
      const provider = yield* providerFor(() => Effect.succeed(response));
      assert.strictEqual(
        (yield* Effect.flip(provider.getIssueSummary!(reference))).reason,
        "failed",
      );
    }
  }),
);

it.effect("reports disabled trackers and refuses pull request references", () =>
  Effect.gen(function* () {
    const disabled = yield* providerFor(() =>
      Effect.succeed(processOutput(encodeJson({ ...repository, has_issues: false }))),
    );
    assert.strictEqual(
      (yield* Effect.flip(
        disabled.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
      )).reason,
      "tracker-disabled",
    );
    const provider = yield* providerFor((input) =>
      Effect.succeed(
        processOutput(
          encodeJson(
            input.path === "user"
              ? baseResponse(input)
              : rawIssue(7, { pull_request: { merged: false } }),
          ),
        ),
      ),
    );
    assert.strictEqual((yield* Effect.flip(provider.getIssueSummary!(reference))).reason, "failed");
  }),
);

it.effect("reads and groups issue and comment reactions, including continued comments", () =>
  Effect.gen(function* () {
    const reactionPaths: string[] = [];
    const provider = yield* providerFor((input) => {
      if (input.path.includes("/issues/comments/3/reactions")) reactionPaths.push(input.path);
      const response = input.path.includes("/reactions")
        ? [
            { content: "+1", user: { login: "ada" } },
            { content: "+1", user: { login: "bob" } },
          ]
        : input.path.endsWith("/timeline") || input.path.endsWith("/comments")
          ? [
              {
                id: 3,
                type: "comment",
                body: "Hello",
                user: { login: "ada" },
                created_at: "2026-10-03T00:00:00Z",
              },
            ]
          : baseResponse(input);
      return Effect.succeed(
        processOutput(encodeJson(response), {
          stderr: input.path.includes("/issues/comments/")
            ? ""
            : 'link: <https://forgejo.test/page=1>; rel="last"',
        }),
      );
    });
    const activity = yield* provider.getIssueActivity(reference);
    assert.deepStrictEqual(activity.reactions, [
      { content: "thumbs-up", count: 2, actors: ["bob"], viewerHasReacted: true },
    ]);
    assert.deepStrictEqual(activity.comments[0]?.reactions, activity.reactions);
    const continued = yield* provider.getIssueComments!({
      ...reference,
      cursor: Buffer.from(encodeJson(["2026-10-03T00:00:00.000Z", 2])).toString("base64url"),
    });
    assert.deepStrictEqual(continued.comments[0]?.reactions, activity.reactions);
    assert.deepStrictEqual(reactionPaths, [
      "repos/acme/web/issues/comments/3/reactions",
      "repos/acme/web/issues/comments/3/reactions",
    ]);
  }),
);

it.effect("propagates auth and rate failures from timeline, fallback and plain comments", () =>
  Effect.gen(function* () {
    for (const reason of ["authentication", "rate-limit"] as const) {
      for (const endpoint of ["timeline", "timeline?", "comments", "reactions"] as const) {
        const provider = yield* providerFor((input) => {
          if (input.path.includes(`/${endpoint}`))
            return Effect.fail(
              new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/repo",
                reason,
                detail: "Denied",
              }),
            );
          if (input.path.endsWith("/timeline"))
            return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
          return Effect.succeed(
            processOutput(
              encodeJson(input.path.endsWith("/comments") ? [rawComment()] : baseResponse(input)),
            ),
          );
        });
        const operation =
          endpoint === "comments" || endpoint === "reactions"
            ? provider.getIssueComments!({
                ...reference,
                cursor: Buffer.from(encodeJson(["2026-10-03T00:00:00.000Z", 2])).toString(
                  "base64url",
                ),
              }).pipe(Effect.asVoid)
            : provider.getIssueActivity(reference).pipe(Effect.asVoid);
        assert.strictEqual(
          (yield* Effect.flip(operation)).reason,
          reason === "authentication" ? "unauthenticated" : "rate-limited",
        );
      }
    }
  }),
);

it.effect("keeps invalid timeline responses and oversized plain comments as loud failures", () =>
  Effect.gen(function* () {
    for (const endpoint of ["timeline", "timeline?", "comments"] as const) {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        if (input.path.includes(`/${endpoint}`))
          return Effect.succeed({
            ...processOutput("["),
            stdoutTruncated: endpoint === "comments",
          });
        if (input.path.endsWith("/timeline"))
          return Effect.succeed({ ...processOutput("["), stdoutTruncated: true });
        return Effect.succeed(processOutput(encodeJson(baseResponse(input))));
      });
      assert.strictEqual(
        (yield* Effect.flip(provider.getIssueActivity(reference))).reason,
        "failed",
      );
      if (endpoint === "timeline") assert(!paths.some((path) => path.includes("/timeline?")));
    }
  }),
);

it.effect("adds and removes reactions only on permitted issues and their own comments", () =>
  Effect.gen(function* () {
    for (const [locked, archived, push, subjectId, commentUrl, allowed] of [
      [false, false, false, undefined, "", true],
      [true, false, false, undefined, "", false],
      [true, false, true, undefined, "", true],
      [false, true, true, undefined, "", false],
      [
        false,
        false,
        false,
        "3",
        "http://forgejo.test:3000/git/api/v1/repos/acme/web/issues/7",
        true,
      ],
      [
        false,
        false,
        false,
        "3",
        "http://forgejo.test:3000/git/api/v1/repos/acme/web/issues/8",
        false,
      ],
      [false, false, false, "3", "http://forgejo.test/git/api/v1/repos/acme/web/issues/7", false],
      [false, false, false, "../3", "", false],
    ] as const) {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const provider = yield* providerFor(
        (input) => {
          if (input.method) writes.push(input);
          const response = input.path.endsWith("/comments/3")
            ? { issue_url: commentUrl }
            : input.path === "repos/git/acme/web"
              ? { ...repository, archived, permissions: { push, admin: push } }
              : rawIssue(7, { is_locked: locked });
          return Effect.succeed(processOutput(encodeJson(response)));
        },
        { login: "default", repository: "acme/web", baseUrl: "http://forgejo.test:3000/git" },
      );
      const input = {
        ...reference,
        host: "forgejo.test:3000",
        repository: "git/acme/web",
        ...(subjectId === undefined ? {} : { subjectId }),
        content: "heart" as const,
      };
      if (allowed) {
        yield* provider.setReaction!({ ...input, reacted: true });
        yield* provider.setReaction!({ ...input, reacted: false });
        assert.deepStrictEqual(
          writes.map((write) => [write.method, write.body]),
          [
            ["POST", { content: "heart" }],
            ["DELETE", { content: "heart" }],
          ],
        );
        assert.strictEqual(
          writes[0]?.path,
          subjectId
            ? "repos/git/acme/web/issues/comments/3/reactions"
            : "repos/git/acme/web/issues/7/reactions",
        );
      } else {
        assert.strictEqual(
          (yield* Effect.flip(provider.setReaction!({ ...input, reacted: true }))).reason,
          "failed",
        );
        assert.strictEqual(writes.length, 0);
      }
    }
  }),
);

it.effect(
  "reads native Markdown and YAML templates and chooser config without requiring push access",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        const response = input.path.endsWith("/issue_templates")
          ? [
              {
                file_name: ".forgejo/ISSUE_TEMPLATE/bug.md",
                name: "Bug",
                about: "Report a bug",
                title: "[Bug]",
                content: "Describe the bug",
                labels: ["bug"],
                assignees: ["ada"],
              },
              {
                file_name: ".gitea/ISSUE_TEMPLATE/form.yml",
                name: "Form",
                about: "Fill out the form",
                body: [
                  {
                    type: "textarea",
                    id: "details",
                    attributes: { label: "Details" },
                    validations: { required: true },
                  },
                ],
                labels: null,
              },
            ]
          : input.path.endsWith("/issue_config")
            ? {
                blank_issues_enabled: false,
                contact_links: [{ name: "Help", about: "Ask for help", url: "https://help.test" }],
              }
            : repository;
        return Effect.succeed(processOutput(encodeJson(response)));
      });
      const list = yield* provider.listIssueTemplates!(reference);
      assert.deepStrictEqual(list.templates[0], {
        key: ".forgejo/ISSUE_TEMPLATE/bug.md",
        name: "Bug",
        about: "Report a bug",
        title: "[Bug]",
        body: "Describe the bug",
        labels: ["bug"],
        assignees: ["ada"],
      });
      const field = list.templates[1]?.fields?.[0];
      assert(field?.kind === "textarea");
      assert.strictEqual(field.required, true);
      assert.strictEqual(list.blankIssuesEnabled, false);
      assert.strictEqual(list.contactLinks[0]?.name, "Help");
      assert(paths.every((path) => !path.includes("contents")));
    }),
);

it.effect("does not hide template authorization failures and rejects disabled trackers", () =>
  Effect.gen(function* () {
    for (const reason of ["authentication", "forbidden", "rate-limit"] as const) {
      const provider = yield* providerFor((input) =>
        input.path.endsWith("/issue_config")
          ? Effect.fail(
              new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/repo",
                reason,
                detail: "Denied",
              }),
            )
          : Effect.succeed(
              processOutput(encodeJson(input.path.endsWith("/issue_templates") ? [] : repository)),
            ),
      );
      assert.strictEqual(
        (yield* Effect.flip(provider.listIssueTemplates!(reference))).reason,
        reason === "authentication"
          ? "unauthenticated"
          : reason === "rate-limit"
            ? "rate-limited"
            : "failed",
      );
    }
    const disabled = yield* providerFor(() =>
      Effect.succeed(processOutput(encodeJson({ ...repository, has_issues: false }))),
    );
    assert.strictEqual(
      (yield* Effect.flip(disabled.listIssueTemplates!(reference))).reason,
      "tracker-disabled",
    );
  }),
);

it.effect(
  "discovers native closing PR references and checks access across repositories below a mount root",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const root = "http://forgejo.test:3000/git";
      const event = (id: number, number: number, action: string, owner = "acme") => ({
        id,
        type: "pull_ref",
        body: "",
        user: { login: "ada" },
        created_at: "2026-10-03T00:00:00Z",
        ref_action: action,
        ref_issue: {
          number,
          html_url: `${root}/${owner}/web/pulls/${number}`,
          pull_request: { merged: false },
        },
      });
      const provider = yield* providerFor(
        (input) => {
          paths.push(input.path);
          if (input.path === "repos/other/web/pulls/10")
            return Effect.fail(
              new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/repo",
                reason: "forbidden",
                detail: "Denied",
              }),
            );
          const response = input.path.endsWith("/timeline")
            ? [
                { ...event(9, 9, "reopens"), created_at: "2026-10-02T00:00:00Z" },
                event(1, 8, "none"),
                event(2, 8, "closes"),
                event(3, 9, "closes"),
                event(4, 9, "reopens"),
                event(5, 10, "closes", "other"),
                event(6, 12, "closes", "%"),
                {
                  ...event(7, 11, "closes"),
                  ref_issue: {
                    number: 11,
                    html_url: "http://other.test/git/acme/web/pulls/11",
                    pull_request: { merged: false },
                  },
                },
                { ...event(8, 8, "neutered"), type: "comment_ref" },
              ]
            : input.path === "repos/acme/web/pulls/8"
              ? rawPull(8, { html_url: `${root}/acme/web/pulls/8`, merged: true })
              : input.path === "repos/acme/web/pulls/9"
                ? rawPull(9, { html_url: `${root}/acme/web/pulls/9`, draft: true })
                : input.path === "repos/git/acme/web"
                  ? repository
                  : baseResponse(input);
          return Effect.succeed(
            processOutput(encodeJson(response), {
              stderr: 'link: <http://forgejo.test:3000/git/page=1>; rel="last"',
            }),
          );
        },
        { login: "default", repository: "acme/web", baseUrl: root },
      );
      const detail = yield* provider.getIssue({
        ...reference,
        host: "forgejo.test:3000",
        repository: "git/acme/web",
      });
      assert.deepStrictEqual(
        detail.linkedPullRequests.map((pull) => [
          pull.repository,
          pull.number,
          pull.state,
          pull.closesIssue,
          pull.isDraft,
        ]),
        [
          ["git/acme/web", 9, "open", false, true],
          ["git/acme/web", 8, "merged", true, false],
        ],
      );
      assert.strictEqual(paths.filter((path) => path === "repos/acme/web/pulls/8").length, 1);
      assert.strictEqual(detail.linkedPullRequestsTruncated, false);
      assert(paths.includes("repos/other/web/pulls/10"));
      assert(!paths.some((path) => path.endsWith("/pulls/11")));
      assert(!paths.some((path) => path.endsWith("/pulls/12")));
    }),
);

it.effect(
  "loads every unique linked PR in batches of five without rereading the full timeline",
  () =>
    Effect.gen(function* () {
      for (const referenceCount of [2, 5, 6, 25]) {
        const paths: string[] = [];
        const provider = yield* providerFor((input) => {
          paths.push(input.path);
          const number = Number(
            /^repos\/acme\/web\/(?:issues|pulls)\/(\d+)$/.exec(input.path)?.[1],
          );
          const response = input.path.endsWith("/timeline")
            ? Array.from({ length: referenceCount * 2 }, (_, i) =>
                rawComment(i + 1, {
                  type: "pull_ref",
                  ref_action: i >= referenceCount ? "closes" : "none",
                  ref_issue: {
                    number: 8 + (i % referenceCount),
                    html_url: `https://forgejo.test/acme/web/pulls/${8 + (i % referenceCount)}`,
                    pull_request: { merged: false },
                  },
                }),
              )
            : number >= 8
              ? rawPull(number)
              : baseResponse(input);
          return Effect.succeed(processOutput(encodeJson(response)));
        });
        const detail = yield* provider.getIssue(reference);
        assert.strictEqual(detail.body, "Body");
        assert.strictEqual(detail.linkedPullRequestsTruncated, referenceCount > 5);
        assert.deepStrictEqual(
          detail.linkedPullRequests.map((pull) => pull.number),
          Array.from({ length: Math.min(referenceCount, 5) }, (_, i) => i + 8),
        );
        assert(detail.linkedPullRequests.every((pull) => pull.closesIssue));
        assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
        assert.strictEqual(
          paths.filter((path) => /^repos\/acme\/web\/(?:issues|pulls)\/(\d+)$/.test(path)).length,
          1 + Math.min(referenceCount, 5),
        );
        let cursor = detail.nextLinkedPullRequestsCursor;
        const numbers = detail.linkedPullRequests.map((pull) => pull.number);
        while (cursor) {
          const result = yield* provider.getIssueLinkedPullRequests!({ ...reference, cursor });
          assert(result.linkedPullRequests.length <= 5);
          assert.strictEqual(result.truncated, result.nextCursor !== null);
          numbers.push(...result.linkedPullRequests.map((pull) => pull.number));
          cursor = result.nextCursor;
        }
        assert.deepStrictEqual(
          numbers,
          Array.from({ length: referenceCount }, (_, i) => i + 8),
        );
        assert.strictEqual(paths.filter((path) => path.endsWith("/timeline")).length, 1);
        assert.strictEqual(
          paths.filter((path) => /^repos\/acme\/web\/(?:issues|pulls)\/(\d+)$/.test(path)).length,
          referenceCount + 1,
        );
        assert(!paths.some((path) => path.includes("/timeline?")));
      }
    }),
);

it.effect("keeps accessible linked PRs and propagates authentication and rate errors", () =>
  Effect.gen(function* () {
    for (const reason of ["not-found", "forbidden", "authentication", "rate-limit"] as const) {
      const provider = yield* providerFor((input) => {
        if (input.path === "repos/acme/web/pulls/8")
          return Effect.fail(
            new ForgejoCli.ForgejoCliError({
              command: "tea",
              cwd: "/repo",
              reason,
              detail: "Denied",
            }),
          );
        const response = input.path.endsWith("/timeline")
          ? [8, 9].map((number) => ({
              id: number,
              type: "pull_ref",
              body: "",
              user: { login: "ada" },
              created_at: "2026-10-03T00:00:00Z",
              ref_issue: {
                number,
                html_url: `https://forgejo.test/acme/web/pulls/${number}`,
                pull_request: { merged: false },
              },
            }))
          : input.path === "repos/acme/web/pulls/9"
            ? rawPull(9)
            : baseResponse(input);
        return Effect.succeed(
          processOutput(encodeJson(response), {
            stderr: 'link: <https://forgejo.test/timeline?page=1>; rel="last"',
          }),
        );
      });
      if (reason === "not-found" || reason === "forbidden") {
        const detail = yield* provider.getIssue(reference);
        assert.deepStrictEqual(
          detail.linkedPullRequests.map((pull) => pull.number),
          [9],
        );
        assert.strictEqual(detail.linkedPullRequestsTruncated, false);
      } else {
        assert.strictEqual(
          (yield* Effect.flip(provider.getIssue(reference))).reason,
          reason === "authentication" ? "unauthenticated" : "rate-limited",
        );
      }
    }
  }),
);

it.effect(
  "globally sorts more than 1000 Gitea issues despite ignored sort and continues equal timestamps",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-12-02T00:00:00Z"));
      const rows = Array.from({ length: 1055 }, (_, i) =>
        rawIssue(1055 - i, 1055 - i === 1 ? { updated_at: "2026-12-01T00:00:00Z" } : {}),
      );
      const provider = yield* providerFor((input) => {
        if (!input.path.includes("?"))
          return Effect.succeed(processOutput(encodeJson(baseResponse(input))));
        return Effect.succeed(issueListOutput(input, rows));
      });
      const input = {
        ...reference,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "ada",
        limit: 20,
      };
      const first = yield* provider.listIssues(input);
      assert.strictEqual(first.items[0]?.number, 1);
      assert.strictEqual(first.continues, true);
      const boundary = first.items.at(-1)!.updatedAt;
      const seenAt = first.items
        .filter((issue) => issue.updatedAt === boundary)
        .map((issue) => issue.number);
      const second = yield* provider.listIssues({
        ...input,
        cursor: { updatedBefore: boundary, seenAt },
      });
      assert.deepStrictEqual(
        second.items.map((issue) => issue.number),
        Array.from({ length: 20 }, (_, i) => 1036 - i),
      );
      assert.strictEqual(second.truncated, true);
    }),
);

it.effect("keeps equal-timestamp boundaries stable when their number order spans pages", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
    const numbers = [8, 6, 10, 9, 7, 5];
    const beforeValues: string[] = [];
    const provider = yield* providerFor((input) => {
      if (!input.path.includes("?")) return Effect.succeed(processOutput(encodeJson(repository)));
      const params = new URL(input.path, "https://forgejo.test").searchParams;
      if (params.has("before")) beforeValues.push(params.get("before")!);
      return Effect.succeed(
        issueListOutput(
          input,
          numbers.map((number) => rawIssue(number)),
          2,
        ),
      );
    });
    const input = {
      ...reference,
      state: "all" as const,
      involvement: "all" as const,
      viewer: "ada",
      limit: 2,
    };
    const first = yield* provider.listIssues(input);
    assert.deepStrictEqual(
      first.items.map((issue) => issue.number),
      [10, 9],
    );
    const second = yield* provider.listIssues({
      ...input,
      cursor: { updatedBefore: first.items[1]!.updatedAt, seenAt: [10, 9] },
    });
    assert.deepStrictEqual(
      second.items.map((issue) => issue.number),
      [8, 7],
    );
    assert(beforeValues.every((value) => value === "2026-10-02T00:00:01.000Z"));
    const third = yield* provider.listIssues({
      ...input,
      cursor: { updatedBefore: first.items[1]!.updatedAt, seenAt: [10, 9, 8, 7] },
    });
    assert.deepStrictEqual(
      third.items.map((issue) => issue.number),
      [6, 5],
    );
    assert.strictEqual(third.truncated, false);
  }),
);

it.effect("reads updated order through adjacent time windows for either order", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-10T00:00:00Z"));
    const rows = [
      rawIssue(3, { updated_at: "2026-09-01T23:59:59Z" }),
      rawIssue(2, { updated_at: "2026-10-09T00:00:00Z" }),
      rawIssue(1, { updated_at: "2026-08-01T00:00:00Z" }),
    ];
    for (const order of ["asc", "desc"] as const) {
      const paths: string[] = [];
      const provider = yield* providerFor((input) => {
        paths.push(input.path);
        return Effect.succeed(
          input.path.includes("?")
            ? issueListOutput(input, rows)
            : processOutput(encodeJson(repository)),
        );
      });
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        sort: "updated",
        order,
        limit: 2,
      });
      assert.deepStrictEqual(
        result.items.map((issue) => issue.number),
        order === "asc" ? [1, 3] : [2, 3],
      );
      assert.strictEqual(result.truncated, true);
      assert(paths.length < 20);
    }
  }),
);

it.effect(
  "keeps full timestamp cursor boundaries exact despite inclusive whole-second native filters",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-02T10:00:00Z"));
      const rows = [
        rawIssue(6, { updated_at: "2026-10-02T10:00:01Z" }),
        rawIssue(5, { updated_at: "2026-10-02T10:00:00.900Z" }),
        rawIssue(4, { updated_at: "2026-10-02T10:00:00.500Z" }),
        rawIssue(3, { updated_at: "2026-10-02T10:00:00.500Z" }),
        rawIssue(2, { updated_at: "2026-10-02T10:00:00.400Z" }),
        rawIssue(1, { updated_at: "2026-10-02T09:59:59.900Z" }),
      ];
      const provider = yield* providerFor((input) =>
        Effect.succeed(
          input.path.includes("?")
            ? issueListOutput(input, rows, 2)
            : processOutput(encodeJson(repository)),
        ),
      );
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 3,
        cursor: { updatedBefore: "2026-10-02T10:00:00.500Z", seenAt: [4] },
      });
      assert.deepStrictEqual(
        result.items.map((issue) => issue.number),
        [3, 2, 1],
      );
      assert.strictEqual(result.truncated, false);
    }),
);

it.effect(
  "reads dense single-second bursts beyond 5000 issues without a count failure or rank cap",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
      const rows = Array.from({ length: 5001 }, (_, i) => rawIssue(i + 1));
      let pages = 0;
      const provider = yield* providerFor((input) => {
        if (input.path.includes("?")) {
          pages++;
          return Effect.succeed(issueListOutput(input, rows));
        }
        return Effect.succeed(processOutput(encodeJson(repository)));
      });
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 20,
      });
      assert.deepStrictEqual(
        result.items.map((issue) => issue.number),
        Array.from({ length: 20 }, (_, i) => 5001 - i),
      );
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.continues, true);
      assert(pages > 100 && pages < 140);
    }),
);

it.effect("uses a complete scan when repository creation time or last-page links are absent", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
    const rows = [rawIssue(8), rawIssue(7, { created_at: "2026-09-01T00:00:00Z" })];
    for (const sort of ["created", "updated"] as const) {
      const provider = yield* providerFor((input) => {
        if (!input.path.includes("?"))
          return Effect.succeed(
            processOutput(encodeJson({ ...repository, created_at: undefined })),
          );
        const response = issueListOutput(input, rows, 1);
        return Effect.succeed({ ...response, stderr: "" });
      });
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 2,
        sort,
        order: "asc",
      });
      assert.deepStrictEqual(
        result.items.map((issue) => issue.number),
        [7, 8],
      );
      assert.strictEqual(result.truncated, false);
    }
  }),
);
