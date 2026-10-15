import type {
  EnvironmentId,
  IssueCapabilities,
  IssueComment,
  IssueCommentsPageInput,
  IssueListEntry,
  IssueListInput,
  IssueListResult,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";

import {
  continueIssueListPage,
  createIssueEnvironmentAtoms,
  issueEntryKey,
  issueScopeKey,
  mergeIssueListPage,
  offeredIssueInvolvements,
  prependIssueComments,
  refreshIssueListPage,
} from "./issues.ts";

describe("issue comment requests", () => {
  it.each([
    { host: "second.atlassian.net" },
    { tracker: "github" as IssueTrackerKind },
    { host: undefined },
    { cursor: "next" },
    {},
  ])("keeps single-flight requests distinct for %j", async (change) => {
    const input: IssueCommentsPageInput = {
      projectId: "project-1" as ProjectId,
      tracker: "jira" as IssueTrackerKind,
      host: "first.atlassian.net",
      scope: "ENG",
      key: "ENG-1",
      cursor: "older",
    };
    const secondInput = { ...input, ...change };
    const latch = Latch.makeUnsafe();
    const started = Promise.withResolvers<void>();
    const calls: IssueCommentsPageInput[] = [];
    const request = vi.spyOn(RpcClient, "requestGuarded");
    request.mockImplementation(((_tag: string, payload: IssueCommentsPageInput) =>
      Effect.sync(() => {
        calls.push(payload);
        started.resolve();
      }).pipe(
        Effect.andThen(latch.await),
        Effect.as({ comments: [], nextCursor: JSON.stringify(payload) }),
      )) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
        ),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    );
    const atoms = createIssueEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    const environmentId = "environment-1" as EnvironmentId;

    try {
      const first = atoms.comments.run(registry, { environmentId, input });
      await started.promise;
      const second = atoms.comments.run(registry, { environmentId, input: secondInput });
      latch.openUnsafe();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({
        _tag: "Success",
        value: { nextCursor: JSON.stringify(input) },
      });
      expect(secondResult).toMatchObject({
        _tag: "Success",
        value: { nextCursor: JSON.stringify(secondInput) },
      });
      expect(calls).toEqual(Object.keys(change).length === 0 ? [input] : [input, secondInput]);
    } finally {
      registry.dispose();
      request.mockRestore();
    }
  });
});

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/app",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/app/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "project-1" as ProjectId,
    projectTitle: "App",
    ...overrides,
  };
}

describe("mergeIssueListPage", () => {
  it("keeps rows from scopes the page did not continue and orders by update", () => {
    const held = [
      entry({ key: "1", updatedAt: "2026-10-03T00:00:00.000Z" }),
      entry({ key: "9", scope: "acme/other", updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const page = [entry({ key: "2", updatedAt: "2026-10-04T00:00:00.000Z" })];
    expect(mergeIssueListPage(held, page).map((row) => row.key)).toEqual(["2", "1", "9"]);
  });

  it("replaces a repeated row with the page's newer words", () => {
    const held = [entry({ key: "1", title: "Old title" })];
    const page = [
      entry({ key: "1", title: "New title", state: { category: "closed", name: "closed" } }),
    ];
    const merged = mergeIssueListPage(held, page);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("New title");
    expect(merged[0]?.state.category).toBe("closed");
  });

  it("keys rows case-insensitively by host and scope, exactly by key", () => {
    expect(issueEntryKey(entry({ key: "1", host: "GitHub.com", scope: "Acme/App" }))).toBe(
      issueEntryKey(entry({ key: "1" })),
    );
    expect(issueEntryKey(entry({ key: "ENG-1" }))).not.toBe(issueEntryKey(entry({ key: "eng-1" })));
  });
});

describe("issue list continuations", () => {
  const cursors = {
    "github.com acme/app": "a",
    "github.com acme/other": "b",
    "linear.app ENG": "c",
  };

  it("keeps a failed scope's cursor when an older server omits error host and tracker", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/app": "2" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([issueEntryKey(entry({ key: "1" }))]),
      errors: [],
    };
    const failed = {
      entries: [],
      nextCursors: {},
      errors: [{ projectId: "project-1" as ProjectId, projectTitle: "App", message: "down" }],
    };
    const continued = continueIssueListPage(held, held.nextCursors, failed, held.firstCursors);
    expect(continued.nextCursors).toEqual(held.nextCursors);
    const refreshed = refreshIssueListPage(held, failed);
    expect(refreshed.entries).toEqual(held.entries);
    expect(refreshed.nextCursors).toEqual(held.nextCursors);
  });

  it.each([
    ["github.com acme/app", "github github.com acme/app"],
    ["github github.com acme/app", "github.com acme/app"],
  ])("refreshes a continued scope when cursors change from %s to %s", (oldKey, newKey) => {
    const first = entry({ key: "1", updatedAt: "2026-10-03T00:00:00.000Z" });
    const tail = entry({ key: "2" });
    const held = {
      entries: [first, tail],
      firstKeys: new Set([issueEntryKey(first)]),
      firstCursors: { [oldKey]: "2" },
      nextCursors: { [oldKey]: "3" },
      errors: [],
    };
    const refreshed = refreshIssueListPage(
      held,
      { entries: [{ ...first, title: "Fresh" }], nextCursors: { [newKey]: "2" }, errors: [] },
      { source: { projectId: first.projectId, host: first.host, scope: first.scope } },
    );
    expect(refreshed.entries.map((row) => row.key)).toEqual(["1", "2"]);
    expect(refreshed.entries[0]?.title).toBe("Fresh");
    expect(refreshed.firstCursors).toEqual({ [newKey]: "2" });
    expect(refreshed.nextCursors).toEqual({ [newKey]: "3" });
  });

  it("keeps same-host trackers separate through retries and source refresh", () => {
    const github = entry({ key: "1", host: "shared.example" });
    const gitlab = entry({ ...github, tracker: "gitlab" as IssueTrackerKind });
    const gh = "github shared.example acme/app";
    const gl = "gitlab shared.example acme/app";
    const held = {
      entries: [github, gitlab],
      nextCursors: { [gh]: "gh2", [gl]: "gl2" },
      firstCursors: { [gh]: "gh2", [gl]: "gl2" },
      firstKeys: new Set([github, gitlab].map(issueEntryKey)),
      errors: [] as IssueListResult["errors"],
    };
    expect(mergeIssueListPage([github], [gitlab])).toHaveLength(2);
    const down = {
      projectId: gitlab.projectId,
      projectTitle: "App",
      tracker: gitlab.tracker,
      host: gitlab.host,
      message: "down",
    };
    const failed = continueIssueListPage(
      held,
      { [gl]: "gl2" },
      { entries: [], nextCursors: {}, errors: [down] },
      held.firstCursors,
    );
    expect(failed.nextCursors).toEqual(held.nextCursors);
    const continued = continueIssueListPage(
      failed,
      { [gl]: "gl2" },
      { entries: [entry({ ...gitlab, key: "2" })], nextCursors: { [gl]: "gl3" }, errors: [] },
      held.firstCursors,
    );
    expect(continued.errors).toEqual([]);
    expect(continued.nextCursors).toEqual({ [gh]: "gh2", [gl]: "gl3" });
    expect(continued.entries).toHaveLength(3);
    const refreshed = refreshIssueListPage(
      continued,
      { entries: [], nextCursors: {}, errors: [] },
      { source: gitlab },
    );
    expect(refreshed.entries).toEqual([github]);
    expect(refreshed.nextCursors).toEqual({ [gh]: "gh2" });
    const narrowed = refreshIssueListPage(held, {
      entries: [gitlab],
      nextCursors: { [gl]: "gl2" },
      errors: [],
      sources: [{ ...gitlab, capabilities: {} as IssueCapabilities }],
    });
    expect(narrowed.entries).toEqual([gitlab]);
    expect(narrowed.nextCursors).toEqual({ [gl]: "gl2" });
  });

  it("keeps other hosts' cursors when one host's page lands", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: cursors,
      firstCursors: cursors,
      firstKeys: new Set<string>(),
      errors: [],
    };
    const sent = { "github.com acme/app": "a", "github.com acme/other": "b" };
    const next = continueIssueListPage(
      held,
      sent,
      {
        entries: [entry({ key: "2" })],
        nextCursors: { "github.com acme/app": "a2" },
        errors: [],
      },
      held.firstCursors,
    );
    expect(next.nextCursors).toEqual({ "linear.app ENG": "c", "github.com acme/app": "a2" });
    expect(next.entries.map((row) => row.key).toSorted()).toEqual(["1", "2"]);
  });

  it("drops a continuation whose cursor a refresh has since moved", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/app": "2" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([issueEntryKey(entry({ key: "1" }))]),
      errors: [],
    };
    const stale = continueIssueListPage(
      held,
      { "github.com acme/app": "4" },
      {
        entries: [entry({ key: "200" })],
        nextCursors: { "github.com acme/app": "5" },
        errors: [],
      },
      held.firstCursors,
    );
    expect(stale).toBe(held);
  });

  it("drops a continuation sent before a refresh that kept the same cursor", () => {
    const at = (key: string, day: number, title = `Issue ${key}`) =>
      entry({ key, title, updatedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z` });
    const cursor = { "github.com acme/app": "2" };
    const held = {
      entries: [at("1", 9), at("2", 8)],
      nextCursors: cursor,
      firstCursors: cursor,
      firstKeys: new Set([at("1", 9), at("2", 8)].map(issueEntryKey)),
      errors: [],
    };
    const refreshed = refreshIssueListPage(held, {
      entries: [at("4", 10, "Fresh"), at("1", 9)],
      nextCursors: cursor,
      errors: [],
    });
    expect(refreshed.nextCursors).toEqual(cursor);
    const oldPage = {
      entries: [at("3", 7), at("4", 6, "Stale")],
      nextCursors: { "github.com acme/app": "3" },
      errors: [],
    };
    expect(continueIssueListPage(refreshed, cursor, oldPage, held.firstCursors)).toBe(refreshed);
    const continued = continueIssueListPage(
      refreshed,
      cursor,
      {
        entries: [at("2", 8), at("3", 7)],
        nextCursors: { "github.com acme/app": "3" },
        errors: [],
      },
      refreshed.firstCursors,
    );
    expect(continued.entries.map((row) => row.title)).toEqual([
      "Fresh",
      "Issue 1",
      "Issue 2",
      "Issue 3",
    ]);
    expect(continued.nextCursors).toEqual({ "github.com acme/app": "3" });
  });

  it("retries a failed scope that has no rows through the listing's sources", () => {
    const source = {
      projectId: "project-3" as ProjectId,
      projectTitle: "Empty",
      tracker: "github" as IssueTrackerKind,
      host: "github.com",
      scope: "acme/empty",
      capabilities: {} as IssueCapabilities,
    };
    const held = {
      entries: [] as ReadonlyArray<IssueListEntry>,
      nextCursors: { "github.com acme/empty": "e2" },
      firstCursors: { "github.com acme/empty": "e2" },
      firstKeys: new Set<string>(),
      errors: [],
      sources: [source],
    };
    const sent = { "github.com acme/empty": "e2" };
    const down = {
      projectId: source.projectId,
      projectTitle: "Empty",
      host: "github.com",
      message: "down",
    };
    const failed = continueIssueListPage(
      held,
      sent,
      { entries: [], nextCursors: {}, errors: [down] },
      held.firstCursors,
    );
    expect(failed.nextCursors).toEqual(sent);
    expect(failed.errors).toEqual([down]);
    const recovered = continueIssueListPage(
      failed,
      sent,
      {
        entries: [entry({ key: "7", scope: "acme/empty", projectId: source.projectId })],
        nextCursors: {},
        errors: [],
      },
      held.firstCursors,
    );
    expect(recovered.errors).toEqual([]);
    expect(recovered.nextCursors).toEqual({});
    expect(recovered.entries.map((row) => row.key)).toEqual(["7"]);
  });

  it("shows a continuation's errors and clears only the retried project's old ones", () => {
    const failure = (projectId: string, host: string, message: string) => ({
      projectId: projectId as ProjectId,
      projectTitle: projectId,
      host,
      message,
    });
    const held = {
      entries: [entry({ key: "1" }), entry({ key: "ENG-1", host: "linear.app", scope: "ENG" })],
      nextCursors: cursors,
      firstCursors: cursors,
      firstKeys: new Set<string>(),
      errors: [
        failure("project-1", "github.com", "old"),
        failure("project-2", "linear.app", "kept"),
      ],
    };
    const failed = continueIssueListPage(
      held,
      { "github.com acme/app": "a" },
      {
        entries: [],
        nextCursors: {},
        errors: [failure("project-1", "github.com", "rate limited")],
      },
      held.firstCursors,
    );
    expect(failed.errors.map((error) => error.message)).toEqual(["kept", "rate limited"]);
    expect(failed.nextCursors["github.com acme/app"]).toBe("a");
    const recovered = continueIssueListPage(
      failed,
      { "github.com acme/app": "a" },
      {
        entries: [entry({ key: "2" })],
        nextCursors: {},
        errors: [],
      },
      held.firstCursors,
    );
    expect(recovered.errors.map((error) => error.message)).toEqual(["kept"]);
  });
});

describe("issue representative changes", () => {
  it.each([true, false])(
    "keeps a single tracker's tail when cursor format changes: %s",
    (qualified) => {
      const first = entry({ key: "1", updatedAt: "2026-10-02T00:00:00.000Z" });
      const tail = entry({ key: "2" });
      const oldKey = qualified ? "github.com acme/app" : "github github.com acme/app";
      const freshKey = qualified ? "github github.com acme/app" : "github.com acme/app";
      const held = {
        entries: [first, tail],
        firstKeys: new Set([issueEntryKey(first)]),
        firstCursors: { [oldKey]: "2" },
        nextCursors: { [oldKey]: "3" },
        errors: [],
      };
      const refreshed = refreshIssueListPage(held, {
        entries: [first],
        nextCursors: { [freshKey]: "2" },
        errors: [],
      });
      expect(refreshed.entries).toEqual(held.entries);
      expect(refreshed.firstCursors).toEqual({ [freshKey]: "2" });
      expect(refreshed.nextCursors).toEqual({ [freshKey]: "3" });
    },
  );

  it.each([
    { failed: false, sources: true },
    { failed: false, sources: false },
    { failed: true, sources: true },
    { failed: true, sources: false },
  ])(
    "keeps mixed tracker cursors separate when GitHub has no fresh cursor: %j",
    ({ failed, sources }) => {
      const github = entry({ key: "1" });
      const tail = entry({ key: "2" });
      const gitlab = entry({ key: "9", tracker: "gitlab" as IssueTrackerKind });
      const legacy = "github.com acme/app";
      const qualified = "gitlab github.com acme/app";
      const held = {
        entries: [github, tail, gitlab],
        ...(sources
          ? {
              sources: [github, gitlab].map((row) => ({
                ...row,
                capabilities: {} as IssueCapabilities,
              })),
            }
          : {}),
        firstKeys: new Set([github, gitlab].map(issueEntryKey)),
        firstCursors: { [qualified]: "o2", [legacy]: "2" },
        nextCursors: { [qualified]: "o2", [legacy]: "3" },
        errors: [],
      };
      const fresh = {
        entries: failed ? [gitlab] : [github, gitlab],
        ...(sources ? { sources: held.sources } : {}),
        nextCursors: { [qualified]: "o2" },
        errors: failed
          ? [
              {
                projectId: github.projectId,
                projectTitle: github.projectTitle,
                tracker: github.tracker,
                host: github.host,
                message: "down",
              },
            ]
          : [],
      };
      const refreshed = refreshIssueListPage(held, fresh);
      expect(refreshed.nextCursors).toEqual(failed ? held.nextCursors : { [qualified]: "o2" });
      expect(refreshed.firstCursors).toEqual(failed ? held.firstCursors : { [qualified]: "o2" });
      expect(refreshed.entries).toEqual(failed ? held.entries : [github, gitlab]);
    },
  );

  it.each([
    { cursor: "github github.com acme/app", sources: true },
    { cursor: "github github.com acme/app", sources: false },
    { cursor: "github.com acme/app", sources: true },
    { cursor: "github.com acme/app", sources: false },
  ])("rebinds earlier rows when a continuation changes project: %j", ({ cursor, sources }) => {
    const old = entry({ key: "1", projectTitle: "Old checkout" });
    const repeated = entry({ key: "2", projectTitle: old.projectTitle });
    const other = entry({
      key: "9",
      tracker: "gitlab" as IssueTrackerKind,
      projectTitle: "Other tracker",
    });
    const replacement = entry({
      key: "2",
      projectId: "replacement" as ProjectId,
      projectTitle: "Current checkout",
      host: "GitHub.COM",
      scope: "Acme/App",
      title: "Updated issue 2",
    });
    const otherCursor = "gitlab github.com acme/app";
    const otherError = {
      projectId: other.projectId,
      projectTitle: other.projectTitle,
      tracker: other.tracker,
      host: other.host,
      message: "Other tracker is unavailable",
    };
    const held = {
      entries: [old, repeated, other],
      sources: [
        { ...old, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
      firstKeys: new Set([old, repeated, other].map(issueEntryKey)),
      firstCursors: { [cursor]: "2", [otherCursor]: "o2" },
      nextCursors: { [cursor]: "2", [otherCursor]: "o2" },
      errors: [otherError],
    };
    const page = {
      entries: [replacement, entry({ ...replacement, key: "3" })],
      ...(sources ? { sources: [{ ...replacement, capabilities: {} as IssueCapabilities }] } : {}),
      nextCursors: { [cursor]: "3" },
      errors: [],
    };
    const continued = continueIssueListPage(held, { [cursor]: "2" }, page, held.firstCursors);
    const rows = continued.entries.filter((row) => row.tracker === old.tracker);
    expect(
      rows.map((row) => [row.projectId, row.projectTitle, row.key, row.title]).toSorted(),
    ).toEqual([
      ["replacement", "Current checkout", "1", old.title],
      ["replacement", "Current checkout", "2", "Updated issue 2"],
      ["replacement", "Current checkout", "3", replacement.title],
    ]);
    expect(continued.entries.find((row) => row.tracker === other.tracker)).toEqual(other);
    expect(rows.find((row) => row.key === "1")).toMatchObject({
      host: old.host,
      scope: old.scope,
      tracker: old.tracker,
    });
    expect(
      continued.sources?.map(({ projectId, projectTitle }) => [projectId, projectTitle]),
    ).toEqual([
      ["replacement", "Current checkout"],
      [other.projectId, other.projectTitle],
    ]);
    expect(continued.firstKeys).toEqual(
      new Set([
        issueEntryKey({ ...old, projectId: replacement.projectId }),
        issueEntryKey(replacement),
        issueEntryKey(other),
      ]),
    );
    expect(continued.firstCursors).toBe(held.firstCursors);
    expect(continued.nextCursors).toEqual({ [cursor]: "3", [otherCursor]: "o2" });
    expect(continued.errors).toEqual([otherError]);
    const fresh = refreshIssueListPage(continued, {
      entries: [entry({ ...replacement, key: "1" }), replacement, other],
      nextCursors: held.firstCursors,
      errors: [otherError],
      sources: [
        { ...replacement, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
    });
    expect(fresh.entries.filter((row) => row.tracker === old.tracker)).toHaveLength(3);
    expect(fresh.nextCursors[cursor]).toBe("3");
    const next = continueIssueListPage(
      fresh,
      { [cursor]: "3" },
      {
        entries: [entry({ ...replacement, key: "3" }), entry({ ...replacement, key: "4" })],
        nextCursors: {},
        errors: [],
      },
      fresh.firstCursors,
    );
    expect(
      next.entries
        .filter((row) => row.tracker === old.tracker)
        .map((row) => row.key)
        .toSorted(),
    ).toEqual(["1", "2", "3", "4"]);
    expect(next.nextCursors).toEqual({ [otherCursor]: "o2" });
    expect(next.errors).toEqual([otherError]);
  });

  it("rebinds and deduplicates an empty successful continuation using its source metadata", () => {
    const old = entry({ key: "1" });
    const replacement = entry({
      ...old,
      projectId: "replacement" as ProjectId,
      projectTitle: "Current checkout",
    });
    const cursor = { "github github.com acme/app": "2" };
    const held = {
      entries: [old, replacement],
      sources: [{ ...old, capabilities: {} as IssueCapabilities }],
      firstKeys: new Set([issueEntryKey(old)]),
      firstCursors: cursor,
      nextCursors: cursor,
      errors: [],
    };
    const page = {
      entries: [],
      sources: [{ ...replacement, capabilities: {} as IssueCapabilities }],
      nextCursors: {},
      errors: [],
    };
    const failed = continueIssueListPage(
      held,
      cursor,
      {
        ...page,
        errors: [
          {
            projectId: replacement.projectId,
            projectTitle: replacement.projectTitle,
            tracker: replacement.tracker,
            host: replacement.host,
            message: "down",
          },
        ],
      },
      held.firstCursors,
    );
    expect(failed.entries).toEqual(held.entries);
    expect(failed.sources).toEqual(held.sources);
    expect(failed.firstKeys).toEqual(held.firstKeys);
    expect(failed.nextCursors).toEqual(cursor);
    const success = continueIssueListPage(failed, cursor, page, held.firstCursors);
    expect(success.errors).toEqual([]);
    expect(success.entries).toEqual([replacement]);
    expect(success.sources?.[0]).toMatchObject({
      projectId: replacement.projectId,
      projectTitle: replacement.projectTitle,
    });
    expect(success.firstKeys).toEqual(new Set([issueEntryKey(replacement)]));
    expect(success.nextCursors).toEqual({});
    const withoutHeldMetadata = continueIssueListPage(
      { ...held, sources: undefined },
      cursor,
      page,
      held.firstCursors,
    );
    expect(withoutHeldMetadata.entries).toEqual([replacement]);
    expect(withoutHeldMetadata.sources).toEqual(page.sources);
    const withoutMetadata = continueIssueListPage(
      held,
      cursor,
      { entries: [], nextCursors: {}, errors: [] },
      held.firstCursors,
    );
    expect(withoutMetadata.entries).toEqual(held.entries);
  });

  it("drops the old owner's tail and restarts its cursor, while keeping failed and unrelated sources", () => {
    const old = entry({ key: "1" });
    const tail = entry({ key: "2" });
    const other = entry({ key: "9", scope: "acme/other", projectId: "other" as ProjectId });
    const replacement = entry({ key: "1", projectId: "replacement" as ProjectId });
    const scope = "github github.com acme/app";
    const otherScope = "github github.com acme/other";
    const held = {
      entries: [old, tail, other],
      firstKeys: new Set([old, other].map(issueEntryKey)),
      firstCursors: { [scope]: "2", [otherScope]: "o2" },
      nextCursors: { [scope]: "3", [otherScope]: "o2" },
      errors: [],
    };
    const fresh = {
      entries: [replacement],
      sources: [
        { ...replacement, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
      nextCursors: { [scope]: "2" },
      errors: [
        {
          projectId: other.projectId,
          projectTitle: "App",
          tracker: other.tracker,
          host: other.host,
          message: "down",
        },
      ],
    };
    const refreshed = refreshIssueListPage(held, fresh);
    expect(refreshed.entries).toHaveLength(2);
    expect(refreshed.entries).toEqual(expect.arrayContaining([replacement, other]));
    expect(refreshed.nextCursors).toEqual({ [scope]: "2", [otherScope]: "o2" });
    const continued = continueIssueListPage(
      refreshed,
      { [scope]: "2" },
      { entries: [entry({ ...replacement, key: "2" })], nextCursors: {}, errors: [] },
      refreshed.firstCursors,
    );
    expect(continued.entries.map(({ projectId, key }) => [projectId, key]).toSorted()).toEqual([
      [other.projectId, "9"],
      ["replacement", "1"],
      ["replacement", "2"],
    ]);
    const failed = refreshIssueListPage(held, {
      ...fresh,
      entries: [],
      errors: [
        {
          projectId: replacement.projectId,
          projectTitle: "App",
          tracker: replacement.tracker,
          host: replacement.host,
          message: "down",
        },
        ...fresh.errors,
      ],
    });
    expect(failed.entries).toEqual(held.entries);
    expect(failed.nextCursors).toEqual(held.nextCursors);
  });
});

describe("refreshIssueListPage", () => {
  const rows = (from: number, to: number, scope = "acme/app") =>
    Array.from({ length: to - from + 1 }, (_, index) =>
      entry({
        key: `${from + index}`,
        scope,
        projectId: (scope === "acme/app" ? "project-1" : "project-2") as ProjectId,
        updatedAt: `2026-10-01T00:00:00.${String(999 - from - index).padStart(3, "0")}Z`,
      }),
    );
  const loaded = {
    entries: [...rows(1, 100), ...rows(201, 250, "acme/other")],
    nextCursors: { "github.com acme/app": "3", "github.com acme/other": "o2" },
    firstCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
    firstKeys: new Set([...rows(1, 50), ...rows(201, 250, "acme/other")].map(issueEntryKey)),
    errors: [] as IssueListResult["errors"],
  };

  it("keeps a continued scope's tail and cursor under a fresh first page", () => {
    const next = refreshIssueListPage(loaded, {
      entries: [...rows(1, 50), ...rows(202, 251, "acme/other")],
      nextCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      errors: [],
    });
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.entries.some((row) => row.key === "201")).toBe(false);
    expect(next.entries.some((row) => row.key === "251")).toBe(true);
    expect(next.nextCursors).toEqual(loaded.nextCursors);
    expect(next.firstCursors).toEqual(loaded.firstCursors);
  });

  it.each(["github.com acme/app", "github github.com acme/app"])(
    "restores an exhausted scope's cursor after an unchanged first-page refresh: %s",
    (scope) => {
      const first = {
        entries: rows(1, 2),
        nextCursors: { [scope]: "2" },
        firstCursors: { [scope]: "2" },
        firstKeys: new Set(rows(1, 2).map(issueEntryKey)),
        errors: [],
      };
      const completed = continueIssueListPage(
        first,
        first.nextCursors,
        {
          entries: rows(3, 4),
          nextCursors: {},
          errors: [],
        },
        first.firstCursors,
      );
      expect(completed.entries).toEqual(rows(1, 4));
      expect(completed.nextCursors).toEqual({});
      const fresh = refreshIssueListPage(completed, {
        entries: rows(1, 2),
        nextCursors: { [scope]: "2" },
        errors: [],
      });
      expect(fresh.entries).toEqual(rows(1, 4));
      expect(fresh.nextCursors).toEqual({ [scope]: "2" });
      expect(fresh.firstKeys).toEqual(first.firstKeys);
      const failed = refreshIssueListPage(fresh, {
        entries: [],
        nextCursors: {},
        errors: [{ projectId: "project-1" as ProjectId, projectTitle: "App", message: "down" }],
      });
      expect(failed.entries).toEqual(fresh.entries);
      expect(failed.nextCursors).toEqual(fresh.nextCursors);
      const next = continueIssueListPage(
        failed,
        { [scope]: "2" },
        {
          entries: rows(3, 5),
          nextCursors: {},
          errors: [],
        },
        failed.firstCursors,
      );
      expect(next.entries).toEqual(rows(1, 5));
      expect(next.nextCursors).toEqual({});
      expect(next.errors).toEqual([]);
      const terminal = refreshIssueListPage(completed, {
        entries: rows(1, 2),
        nextCursors: {},
        errors: [],
      });
      expect(terminal.entries).toEqual(rows(1, 2));
      expect(terminal.nextCursors).toEqual({});
    },
  );

  it.each([40, 50])(
    "drops a continued scope's tail when a fresh first page of %i rows ends the listing",
    (count) => {
      const next = refreshIssueListPage(loaded, {
        entries: [...rows(1, count), ...rows(201, 250, "acme/other")],
        nextCursors: { "github.com acme/other": "o2" },
        errors: [],
      });
      expect(next.entries.filter((row) => row.scope === "acme/app")).toEqual(rows(1, count));
      expect(next.nextCursors).toEqual({ "github.com acme/other": "o2" });
      expect(next.firstCursors).toEqual({ "github.com acme/other": "o2" });
    },
  );

  it("replaces the old first page and keeps the loaded tail", () => {
    const [one, two, three] = rows(1, 3);
    const held = {
      entries: [one!, two!, three!],
      nextCursors: { "github.com acme/app": "3" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([one!, two!].map(issueEntryKey)),
      errors: [],
    };
    const next = refreshIssueListPage(held, {
      entries: [{ ...two!, title: "Renamed" }, entry({ key: "4" })],
      nextCursors: { "github.com acme/app": "2" },
      errors: [],
    });
    expect(next.entries.map((row) => [row.key, row.title]).toSorted()).toEqual([
      ["2", "Renamed"],
      ["3", "Issue 3"],
      ["4", "Issue 4"],
    ]);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2" });
    expect(next.firstKeys).toEqual(new Set(["2", "4"].map((key) => issueEntryKey(entry({ key })))));
  });

  it("reopens a finished scope when a new row shifts its first page", () => {
    const [one, two, three] = rows(1, 3);
    const zero = entry({ key: "0", updatedAt: "2026-10-02T00:00:00.000Z" });
    const held = {
      entries: [one!, two!, three!],
      nextCursors: {},
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([one!, two!].map(issueEntryKey)),
      errors: [],
    };
    const refreshed = refreshIssueListPage(held, {
      entries: [zero, one!],
      nextCursors: { "github.com acme/app": "2" },
      errors: [],
    });
    expect(refreshed.entries.map((row) => row.key)).toEqual(["0", "1", "3"]);
    expect(refreshed.nextCursors).toEqual({
      "github.com acme/app": "2",
    });
    const continued = continueIssueListPage(
      refreshed,
      refreshed.nextCursors,
      { entries: [two!, three!], nextCursors: {}, errors: [] },
      refreshed.firstCursors,
    );
    expect(continued.entries.map((row) => row.key)).toEqual(["0", "1", "2", "3"]);
  });

  it("takes a finished first page's end when nothing was continued", () => {
    const next = refreshIssueListPage(
      {
        entries: rows(1, 50),
        nextCursors: {},
        firstCursors: {},
        firstKeys: new Set(rows(1, 50).map(issueEntryKey)),
        errors: [],
      },
      { entries: rows(1, 50), nextCursors: { "github.com acme/app": "2" }, errors: [] },
    );
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2" });
    expect(next.firstCursors).toEqual({ "github.com acme/app": "2" });
  });

  it("drops a mutated row the fresh page of its source no longer lists", () => {
    const next = refreshIssueListPage(
      loaded,
      { entries: rows(2, 51), nextCursors: { "github.com acme/app": "2" }, errors: [] },
      {
        source: {
          tracker: "github",
          projectId: "project-1",
          host: "GitHub.com",
          scope: "Acme/App",
        },
        removed: issueEntryKey(entry({ key: "1" })),
      },
    );
    expect(next.entries.some((row) => row.key === "1")).toBe(false);
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(99);
    expect(next.entries.filter((row) => row.scope === "acme/other")).toHaveLength(50);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2", "github.com acme/other": "o2" });
  });

  it("keeps a failed source's rows and cursors and shows its fresh error", () => {
    const next = refreshIssueListPage(
      loaded,
      {
        entries: rows(202, 251, "acme/other"),
        nextCursors: { "github.com acme/other": "o2" },
        errors: [
          {
            projectId: "project-1" as ProjectId,
            projectTitle: "App",
            host: "github.com",
            message: "down",
          },
        ],
      },
      { removed: issueEntryKey(entry({ key: "1" })) },
    );
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.nextCursors).toEqual(loaded.nextCursors);
    expect(next.entries.some((row) => row.key === "251")).toBe(true);
    expect(next.errors.map((error) => error.message)).toEqual(["down"]);
  });

  it("forgets a scope the fresh listing no longer binds", () => {
    const next = refreshIssueListPage(
      { ...loaded, sources: [] },
      {
        entries: rows(1, 50),
        nextCursors: { "github.com acme/app": "2" },
        errors: [],
        sources: [
          {
            projectId: "project-1" as ProjectId,
            projectTitle: "App",
            tracker: "github" as IssueTrackerKind,
            host: "github.com",
            scope: "acme/app",
            capabilities: {} as IssueCapabilities,
          },
        ],
      },
    );
    expect(next.entries.some((row) => row.scope === "acme/other")).toBe(false);
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "3" });
    expect(next.firstCursors).toEqual({ "github.com acme/app": "2" });
  });

  it("refreshes only the named source's rows and cursors", () => {
    const held = {
      entries: [...rows(1, 50), ...rows(201, 250, "acme/other")],
      nextCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      firstCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      firstKeys: new Set([...rows(1, 50), ...rows(201, 250, "acme/other")].map(issueEntryKey)),
      errors: [],
    };
    const next = refreshIssueListPage(
      held,
      { entries: [entry({ key: "1", title: "Retitled" })], nextCursors: {}, errors: [] },
      {
        source: {
          tracker: "github",
          projectId: "project-1",
          host: "github.com",
          scope: "acme/app",
        },
      },
    );
    expect(next.entries.filter((row) => row.scope === "acme/app").map((row) => row.title)).toEqual([
      "Retitled",
    ]);
    expect(next.entries.filter((row) => row.scope === "acme/other")).toHaveLength(50);
    expect(next.nextCursors).toEqual({ "github.com acme/other": "o2" });
  });
});

describe("issueScopeKey", () => {
  it("matches one scope by case, and keeps other environments and trackers apart", () => {
    const scope = { tracker: "github", host: "github.com", scope: "acme/app" };
    const environment = "env-1" as EnvironmentId;
    expect(issueScopeKey(environment, { ...scope, host: "GitHub.com", scope: "Acme/App" })).toBe(
      issueScopeKey(environment, scope),
    );
    expect(issueScopeKey("env-2" as EnvironmentId, scope)).not.toBe(
      issueScopeKey(environment, scope),
    );
    expect(issueScopeKey(environment, { ...scope, tracker: "jira" })).not.toBe(
      issueScopeKey(environment, scope),
    );
  });
});

describe("offeredIssueInvolvements", () => {
  const capabilities = (involvements?: IssueCapabilities["involvements"]) =>
    ({ involvements }) as IssueCapabilities;

  it("offers every choice while any readable tracker has not narrowed them", () => {
    expect(
      offeredIssueInvolvements(
        [{ capabilities: capabilities(["all", "assigned"]) }, { capabilities: capabilities() }],
        "all",
      ),
    ).toBeNull();
  });

  it("offers the union of declared choices and keeps the active one", () => {
    expect(
      offeredIssueInvolvements(
        [{ capabilities: capabilities(["all", "assigned", "authored"]) }, { capabilities: null }],
        "mentioned",
      ),
    ).toEqual(new Set(["mentioned", "all", "assigned", "authored"]));
  });
});

describe("prependIssueComments", () => {
  const comment = (id: string): IssueComment => ({
    id,
    author: null,
    body: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    url: null,
  });

  it("puts older comments first and drops ones already shown", () => {
    const current = [comment("c3"), comment("c4")];
    const older = [comment("c1"), comment("c2"), comment("c3")];
    expect(prependIssueComments(current, older).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("held issue list viewers", () => {
  function issueReadHarness() {
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    );
    const registry = AtomRegistry.make();
    return {
      atoms: createIssueEnvironmentAtoms(runtime),
      registry,
      dispose: () => registry.dispose(),
    };
  }

  const row = (key: string, overrides: Partial<IssueListEntry> = {}) =>
    entry({ ...overrides, key });
  const source = (entry: IssueListEntry) => ({ ...entry, capabilities: {} as IssueCapabilities });
  const cursor = "github github.com acme/app";
  const answer = (
    entries: IssueListResult["entries"],
    nextCursors: IssueListResult["nextCursors"],
    viewer: string | null = "A",
  ): IssueListResult => ({
    entries,
    nextCursors,
    viewers: viewer === null ? {} : { "github github.com": viewer },
    sources: [source(row("source"))],
    trackers: [],
    errors: [],
  });
  const first = (page = answer([row("first")], { [cursor]: "A2" })) => ({
    answer: page,
    entries: page.entries,
    sources: page.sources,
    errors: page.errors,
    nextCursors: page.nextCursors,
    firstCursors: page.nextCursors,
    firstKeys: new Set(page.entries.map(issueEntryKey)),
  });
  const loaded = (key = cursor) => {
    const held = first(answer([row("first")], { [key]: "A2" }));
    return continueIssueListPage(
      held,
      held.nextCursors,
      answer([row("A-tail")], { [key]: "A3" }),
      held.firstCursors,
    );
  };
  const keys = (page: { entries: IssueListResult["entries"] }) =>
    page.entries.map((entry) => entry.key);

  it.each([
    { from: cursor, to: "github.com acme/app", migrateFirst: false },
    { from: cursor, to: "github.com acme/app", migrateFirst: true },
    { from: "github.com acme/app", to: cursor, migrateFirst: false },
    { from: "github.com acme/app", to: cursor, migrateFirst: true },
  ])("resets viewer cursors across native cursor aliases: %j", ({ from, to, migrateFirst }) => {
    const other = row("other-first", {
      tracker: "gitlab" as IssueTrackerKind,
      projectId: "other" as ProjectId,
    });
    const otherCursor = "gitlab github.com acme/app";
    const initial = {
      ...answer([row("first"), other], { [from]: "A2", [otherCursor]: "O2" }),
      sources: [source(row("first")), source(other)],
      viewers: { "github github.com": "A", "gitlab github.com": "other" },
    };
    const held = first(initial);
    const continued = continueIssueListPage(
      held,
      held.nextCursors,
      {
        ...initial,
        entries: [row("A-tail"), row("other-tail", other)],
        nextCursors: { [from]: "A3", [otherCursor]: "O3" },
      },
      held.firstCursors,
    );
    const before = migrateFirst
      ? continueIssueListPage(
          continued,
          { [from]: "A3" },
          {
            ...initial,
            entries: [row("A-more")],
            nextCursors: { [to]: "A4" },
          },
          continued.firstCursors,
        )
      : continued;
    const sent = migrateFirst ? { [to]: "A4" } : { [from]: "A3" };
    const switched = continueIssueListPage(
      before,
      sent,
      {
        ...initial,
        viewers: { "github github.com": "B" },
        entries: [row("B-first")],
        nextCursors: { [to]: "B2" },
      },
      before.firstCursors,
    );
    expect(keys(switched).toSorted()).toEqual(["B-first", "other-first", "other-tail"]);
    expect(switched.nextCursors).toEqual({ [to]: "B2", [otherCursor]: "O3" });
    expect(switched.firstCursors).toEqual({ [to]: "B2", [otherCursor]: "O2" });
    expect(switched.firstKeys).toEqual(
      new Set([issueEntryKey(row("B-first")), issueEntryKey(other)]),
    );
  });

  it.each([cursor, "github.com acme/app"])(
    "drops old private rows and resets %s on a changed or missing viewer",
    (key) => {
      for (const viewer of ["B", null]) {
        const held = loaded(key);
        const fresh = answer(
          [row("first", { title: "Shared issue under B" })],
          { [key]: "B2" },
          viewer,
        );
        const next = refreshIssueListPage(held, fresh);
        expect(keys(next)).toEqual(["first"]);
        expect(next.nextCursors).toEqual(fresh.nextCursors);
        expect(next.firstCursors).toEqual(fresh.nextCursors);
        expect(next.firstKeys).toEqual(new Set([issueEntryKey(row("first"))]));
      }
    },
  );

  it.each(["B", null])(
    "resets legacy host-only viewer A to %s without losing unrelated hosts",
    (viewer) => {
      const remote = row("remote", { host: "github.corp" });
      const initial = {
        ...answer([row("first"), remote], { [cursor]: "A2" }),
        viewers: { "github.com": "A", "github.corp": "remote" },
        sources: [source(row("first")), source(remote)],
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail")],
          nextCursors: { [cursor]: "A3" },
        },
        held.firstCursors,
      );
      const fresh = {
        ...initial,
        entries: [row("B-first"), remote],
        viewers:
          viewer === null
            ? { "github.corp": "remote" }
            : { "github.com": viewer, "github.corp": "remote" },
        nextCursors: { [cursor]: "B2" },
      };
      const next = refreshIssueListPage(continued, fresh);
      expect(keys(next)).toEqual(["B-first", "remote"]);
      expect(next.nextCursors).toEqual({ [cursor]: "B2" });
      const switched = continueIssueListPage(
        continued,
        continued.nextCursors,
        {
          ...fresh,
          entries: [row("B-first")],
        },
        continued.firstCursors,
      );
      expect(keys(switched)).toEqual(["remote", "B-first"]);
      expect(switched.nextCursors).toEqual({ [cursor]: "B2" });
    },
  );

  it.each([true, false])(
    "does not borrow a host-only viewer across trackers, with source metadata %s",
    (sources) => {
      const other = row("other", {
        tracker: "gitlab" as IssueTrackerKind,
        projectId: "other" as ProjectId,
      });
      const initial = {
        ...answer([row("first")], { [cursor]: "A2" }),
        sources: sources ? [source(row("first")), source(other)] : undefined,
        trackers: [row("first"), other].map((entry) => ({
          tracker: entry.tracker,
          host: entry.host,
          projectCount: 1,
          configured: true,
          capabilities: {} as IssueCapabilities,
          detail: null,
        })),
        viewers: { "github github.com": "A", "gitlab github.com": "other", "github.com": "legacy" },
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail")],
          nextCursors: { [cursor]: "A3" },
        },
        held.firstCursors,
      );
      const ambiguous = refreshIssueListPage(continued, {
        ...initial,
        viewers: { "github.com": "B" },
      });
      expect(keys(ambiguous)).toEqual(["A-tail", "first"]);
      expect(ambiguous.nextCursors).toEqual({ [cursor]: "A3" });
      const resolved = refreshIssueListPage(ambiguous, {
        ...initial,
        entries: [row("B-first")],
        viewers: { "github github.com": "B" },
        nextCursors: { [cursor]: "B2" },
      });
      expect(keys(resolved)).toEqual(["B-first"]);
      expect(resolved.nextCursors).toEqual({ [cursor]: "B2" });
    },
  );

  it("keeps pagination for the same viewer and for pages without viewer context", () => {
    const held = loaded();
    for (const fresh of [
      answer([row("first")], { [cursor]: "A2" }),
      { entries: [row("first")], nextCursors: { [cursor]: "A2" }, errors: [] },
    ]) {
      const next = refreshIssueListPage(held, fresh);
      expect(keys(next)).toEqual(["A-tail", "first"]);
      expect(next.nextCursors).toEqual({ [cursor]: "A3" });
    }
  });

  it.each(["refresh", "continue"])(
    "keeps failed and unrelated sources during %s, then drops a recovered source's old viewer tail",
    (operation) => {
      const failed = row("failed-first", {
        scope: "acme/failed",
        projectId: "failed" as ProjectId,
      });
      const other = row("other-first", {
        tracker: "gitlab" as IssueTrackerKind,
        projectId: "other" as ProjectId,
      });
      const failedCursor = "github github.com acme/failed";
      const otherCursor = "gitlab github.com acme/app";
      const initial = {
        ...answer([row("first"), failed, other], {
          [cursor]: "A2",
          [failedCursor]: "F2",
          [otherCursor]: "O2",
        }),
        sources: [source(row("first")), source(failed), source(other)],
        viewers: { "github github.com": "A", "gitlab github.com": "other" },
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail"), row("failed-tail", failed), row("other-tail", other)],
          nextCursors: { [cursor]: "A3", [failedCursor]: "F3", [otherCursor]: "O3" },
        },
        held.firstCursors,
      );
      const fresh = {
        ...initial,
        viewers: { "github github.com": "B", "gitlab github.com": "other" },
        entries: [row("B-first"), other],
        nextCursors: { [cursor]: "B2", [otherCursor]: "O2" },
        errors: [
          {
            projectId: failed.projectId,
            projectTitle: failed.projectTitle,
            tracker: failed.tracker,
            host: failed.host,
            message: "unavailable",
          },
        ],
      };
      const next =
        operation === "refresh"
          ? refreshIssueListPage(continued, fresh)
          : continueIssueListPage(
              continued,
              { [cursor]: "A3", [failedCursor]: "F3" },
              {
                ...fresh,
                entries: [row("B-first")],
                viewers: { "github github.com": "B" },
                nextCursors: { [cursor]: "B2" },
              },
              continued.firstCursors,
            );
      expect(keys(next).toSorted()).toEqual([
        "B-first",
        "failed-first",
        "failed-tail",
        "other-first",
        "other-tail",
      ]);
      expect(next.nextCursors).toEqual({
        [cursor]: "B2",
        [failedCursor]: "F3",
        [otherCursor]: "O3",
      });
      const recovered = refreshIssueListPage(
        next,
        {
          ...answer([row("recovered", failed)], { [failedCursor]: "B2" }, "B"),
          sources: [source(failed)],
        },
        { source: failed },
      );
      expect(keys(recovered).toSorted()).toEqual([
        "B-first",
        "other-first",
        "other-tail",
        "recovered",
      ]);
      expect(recovered.nextCursors).toEqual({
        [cursor]: "B2",
        [failedCursor]: "B2",
        [otherCursor]: "O3",
      });
    },
  );

  it("limits a continued viewer change to the requested scopes and native host", () => {
    const sibling = row("sibling", { scope: "acme/sibling" });
    const remote = row("remote", { host: "github.corp" });
    const siblingCursor = "github github.com acme/sibling";
    const remoteCursor = "github github.corp acme/app";
    const page = {
      ...answer([row("first"), sibling, remote], {
        [cursor]: "A2",
        [siblingCursor]: "S2",
        [remoteCursor]: "R2",
      }),
      sources: [source(row("first")), source(sibling), source(remote)],
      viewers: { "github github.com": "A", "github github.corp": "remote" },
    };
    const held = first(page);
    const next = continueIssueListPage(
      held,
      { [cursor]: "A2" },
      {
        ...answer([row("B-first")], { [cursor]: "B2" }, "B"),
        sources: page.sources,
      },
      held.firstCursors,
    );
    expect(keys(next).toSorted()).toEqual(["B-first", "remote", "sibling"]);
    expect(next.nextCursors).toEqual({
      [cursor]: "B2",
      [siblingCursor]: "S2",
      [remoteCursor]: "R2",
    });
    expect(next.firstCursors).toEqual(next.nextCursors);
  });

  it("uses the continued viewer instead of the original answer on the next refresh", () => {
    const held = loaded();
    const switched = continueIssueListPage(
      held,
      held.nextCursors,
      answer([row("B-first")], { [cursor]: "B2" }, "B"),
      held.firstCursors,
    );
    expect(keys(switched)).toEqual(["B-first"]);
    expect(switched.firstCursors).toEqual({ [cursor]: "B2" });
    const continued = continueIssueListPage(
      switched,
      switched.nextCursors,
      answer([row("B-tail")], { [cursor]: "B3" }, "B"),
      switched.firstCursors,
    );
    const next = refreshIssueListPage(continued, answer([row("B-first")], { [cursor]: "B2" }, "B"));
    expect(keys(next)).toEqual(["B-tail", "B-first"]);
    expect(next.nextCursors).toEqual({ [cursor]: "B3" });
    expect(keys(refreshIssueListPage(next, answer([row("A-again")], { [cursor]: "A2" })))).toEqual([
      "A-again",
    ]);
  });

  it.each([
    { cursor: "gitlab shared.example acme/app", viewer: "B" },
    { cursor: "shared.example acme/app", viewer: "B" },
    { cursor: "gitlab shared.example acme/app", viewer: "A" },
    { cursor: "shared.example acme/app", viewer: "A" },
  ])("restarts a changed viewer from page one once: %j", async ({ cursor, viewer }) => {
    const { atoms, registry, dispose } = issueReadHarness();
    const native = row("A-first", {
      tracker: "gitlab" as IssueTrackerKind,
      host: "shared.example",
      projectId: "old" as ProjectId,
    });
    const current = { ...native, projectId: "current" as ProjectId };
    const failed = row("failed-first", {
      ...native,
      projectId: "failed" as ProjectId,
      scope: "acme/failed",
    });
    const unrelated = row("other-first", { host: native.host });
    const failedCursor = "gitlab shared.example acme/failed";
    const otherCursor = "github shared.example acme/app";
    const firstRows = Array.from({ length: 50 }, (_, index) => row(`A-${index}`, native));
    const initial = {
      ...answer([...firstRows, failed, unrelated], {
        [cursor]: "2",
        [failedCursor]: "failed-2",
        [otherCursor]: "other-2",
      }),
      sources: [source(native), source(failed), source(unrelated)],
      viewers: { "gitlab shared.example": "A", "github shared.example": "other" },
    };
    const pageTwo = {
      ...initial,
      entries: viewer === "B" ? [] : [row("A-tail", current)],
      sources: [source(current), source(current), source(failed)],
      viewers: { "gitlab shared.example": viewer },
      nextCursors: {},
      errors: [
        {
          projectId: failed.projectId,
          projectTitle: failed.projectTitle,
          tracker: failed.tracker,
          host: failed.host,
          message: "unavailable",
        },
      ],
    };
    const firstForB = {
      ...initial,
      entries: [row("B-only", current)],
      sources: [source(current)],
      viewers: { "gitlab shared.example": "B" },
      nextCursors: {},
    };
    const replies = viewer === "B" ? [initial, pageTwo, firstForB] : [initial, pageTwo];
    const request = vi.spyOn(RpcClient, "requestGuarded");
    request.mockImplementation((() => Effect.succeed(replies.shift()!)) as unknown as Parameters<
      typeof request.mockImplementation
    >[0]);
    const read = async (input: IssueListInput) => {
      const result = await atoms.listPage.run(registry, {
        environmentId: "environment" as EnvironmentId,
        input,
      });
      if (result._tag !== "Success") throw new Error("list read failed");
      return result.value;
    };
    try {
      const input = { state: "all" as const, involvement: "assigned" as const, limit: 50 };
      const held = first(await read(input));
      const sent = { [cursor]: "2", [failedCursor]: "failed-2" };
      const next = continueIssueListPage(
        held,
        sent,
        await read({ ...input, cursors: sent }),
        held.firstCursors,
      );
      let completed = next;
      for (const restart of next.restartSources ?? []) {
        const fresh = await read({ ...input, projectId: restart.projectId, host: restart.host });
        completed = refreshIssueListPage(completed, fresh, {
          source: { ...restart, host: restart.host! },
        });
      }
      expect(request.mock.calls.map(([tag]) => tag)).toEqual(
        Array(viewer === "B" ? 3 : 2).fill("issues.list"),
      );
      expect(request.mock.calls.map(([, payload]) => payload)).toEqual([
        input,
        { ...input, cursors: sent },
        ...(viewer === "B" ? [{ ...input, projectId: current.projectId, host: current.host }] : []),
      ]);
      expect(replies).toEqual([]);
      expect(keys(completed).toSorted()).toEqual(
        (viewer === "B"
          ? ["B-only", "failed-first", "other-first"]
          : [...firstRows.map((row) => row.key), "A-tail", "failed-first", "other-first"]
        ).toSorted(),
      );
      expect(completed.nextCursors).toEqual({
        [failedCursor]: "failed-2",
        [otherCursor]: "other-2",
      });
      expect(completed.errors).toEqual(pageTwo.errors);
      if (viewer === "B")
        expect(completed.firstKeys).toEqual(
          new Set([
            issueEntryKey(row("B-only", current)),
            issueEntryKey(failed),
            issueEntryKey(unrelated),
          ]),
        );
      expect(next.restartSources).toEqual(viewer === "B" ? [source(current)] : []);
      expect(completed.restartSources).toEqual([]);
      const stale = continueIssueListPage(next, sent, pageTwo, held.firstCursors);
      expect(stale).toBe(next);
    } finally {
      dispose();
      request.mockRestore();
    }
  });

  it.each(["assigned", "all"] as const)(
    "resets %s rows using only the requested list reads",
    async (involvement) => {
      const { atoms, registry, dispose } = issueReadHarness();
      const replies = [
        answer([row("A-first")], { [cursor]: "A2" }),
        answer([row("A-tail")], { [cursor]: "A3" }),
        answer([row("B-first")], { [cursor]: "B2" }, "B"),
      ];
      const request = vi.spyOn(RpcClient, "requestGuarded");
      request.mockImplementation((() => Effect.succeed(replies.shift()!)) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const target = {
        environmentId: "environment" as EnvironmentId,
        input: { state: "all" as const, involvement },
      };
      try {
        const read = async (cursors = {}) => {
          const result = await atoms.listPage.run(registry, {
            ...target,
            input: { ...target.input, cursors },
          });
          if (result._tag !== "Success") throw new Error("list read failed");
          return result.value;
        };
        const held = first(await read());
        const continued = continueIssueListPage(
          held,
          held.nextCursors,
          await read(held.nextCursors),
          held.firstCursors,
        );
        const next = refreshIssueListPage(continued, await read());
        expect(request.mock.calls.map(([tag]) => tag)).toEqual([
          "issues.list",
          "issues.list",
          "issues.list",
        ]);
        expect(replies).toEqual([]);
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual({ [cursor]: "B2" });
      } finally {
        dispose();
        request.mockRestore();
      }
    },
  );
});
