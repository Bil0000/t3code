import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
const repository = {
  full_name: "acme/web",
  html_url: "https://forgejo.test/acme/web",
  has_issues: true,
  permissions: { push: false, admin: false },
};
const baseResponse = (input: ForgejoCli.ForgejoApiInput) =>
  input.path === "user"
    ? { login: "ada" }
    : input.path === "repos/acme/web"
      ? repository
      : rawIssue();
const providerFor = (
  api: ForgejoCli.ForgejoCli["Service"]["api"],
  target = { login: "default", repository: "acme/web", baseUrl: "https://forgejo.test" },
) =>
  ForgejoIssueProvider.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api,
        resolveRepository: () => Effect.succeed(target),
      }),
    ),
  );

it.effect("sorts complete Forgejo issue pages and honors a server's smaller page cap", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      assert.strictEqual(input.host, reference.host);
      assert.strictEqual(input.repository, reference.repository);
      const page = new URL(input.path, "https://forgejo.test").searchParams.get("page");
      const rows =
        page === "1"
          ? [rawIssue(8, { created_at: "2026-10-03T00:00:00Z" })]
          : page === "2"
            ? [rawIssue(7, { updated_at: "2026-10-04T00:00:00Z" })]
            : [];
      return Effect.succeed(processOutput(encodeJson(page ? rows : repository)));
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
    assert.strictEqual(updated.continues, false);
    assert.strictEqual(paths.length, 4);
    const query = new URL(paths[1]!, "https://forgejo.test").searchParams;
    assert.strictEqual(query.get("type"), "issues");
    assert.strictEqual(query.get("assigned_by"), "ada");
    assert.strictEqual(query.get("q"), "hello & bye");
    assert.strictEqual(query.get("sort"), "recentupdate");
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

it.effect("requests native sorting before the issue page cap", () =>
  Effect.gen(function* () {
    for (const [sort, order, nativeSort] of [
      ["created", "desc", "latest"],
      ["created", "asc", "oldest"],
      ["updated", "desc", "recentupdate"],
      ["updated", "asc", "leastupdate"],
    ] as const) {
      const provider = yield* providerFor((input) => {
        if (!input.path.includes("?")) return Effect.succeed(processOutput(encodeJson(repository)));
        const params = new URL(input.path, "https://forgejo.test").searchParams;
        const page = Number(params.get("page"));
        const rows =
          params.get("sort") === nativeSort
            ? [rawIssue(page === 1 ? 1001 : page)]
            : [rawIssue(page)];
        return Effect.succeed(processOutput(encodeJson(rows)));
      });
      const result = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        sort,
        order,
        limit: 100,
      });
      assert(result.items.some((issue) => issue.number === 1001));
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.continues, false);
    }
  }),
);

it.effect("stops issue paging when Link has no next page and excludes pull requests", () =>
  Effect.gen(function* () {
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

it.effect("keeps comments paging separate from timeline events", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const comment = {
      id: 3,
      body: "Hello",
      user: { login: "ada" },
      created_at: "2026-10-03T00:00:00Z",
    };
    const provider = yield* providerFor((input) => {
      paths.push(input.path);
      const response = input.path.includes("/timeline")
        ? [
            { ...comment, id: 4, type: "close" },
            {
              ...comment,
              id: 5,
              type: "assignees",
              assignee: { login: "bob" },
              removed_assignee: true,
            },
            { ...comment, id: 6, type: "new_unknown_kind" },
            { ...comment, id: 7, type: "label", body: "1", label: { id: 4, name: "bug" } },
            { ...comment, id: 8, type: "label", body: "", label: { id: 4, name: "bug" } },
            null,
          ]
        : input.path.includes("/comments?")
          ? [comment]
          : rawIssue();
      const stderr =
        input.path.endsWith("page=1") && input.path.includes("/comments?")
          ? 'link: <https://forgejo.test/comments?page=2>; rel="next"'
          : 'link: <https://forgejo.test/page=1>; rel="last"';
      return Effect.succeed(processOutput(encodeJson(response), { stderr }));
    });
    const activity = yield* provider.getIssueActivity(reference);
    assert.strictEqual(activity.commentCount, 3);
    assert.strictEqual(activity.commentsTruncated, true);
    assert.strictEqual(activity.nextCommentsCursor, "2");
    assert.deepStrictEqual(
      activity.events.map((event) => [event.kind, event.detail]),
      [
        ["closed", null],
        ["unassigned", "bob"],
        ["labeled", "bug"],
        ["unlabeled", "bug"],
      ],
    );
    const next = yield* provider.getIssueComments!({ ...reference, cursor: "2" });
    assert.strictEqual(next.nextCursor, null);
    assert.strictEqual(next.comments[0]?.id, "3");
    assert(paths.some((path) => path.endsWith("comments?limit=50&page=2")));
    const before = paths.length;
    assert.strictEqual(
      (yield* Effect.flip(provider.getIssueComments!({ ...reference, cursor: "../../other" })))
        .reason,
      "failed",
    );
    assert.strictEqual(paths.length, before);
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
