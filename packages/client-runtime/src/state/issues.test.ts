import type {
  EnvironmentId,
  IssueCapabilities,
  IssueComment,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  continueIssueListPage,
  issueEntryKey,
  issueListCursorsOn,
  issueScopeKey,
  mergeIssueListPage,
  offeredIssueInvolvements,
  prependIssueComments,
  refreshIssueListPage,
} from "./issues.ts";

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

  it("continues only the scopes of the chosen host", () => {
    expect(issueListCursorsOn(cursors, "GitHub.com")).toEqual({
      "github.com acme/app": "a",
      "github.com acme/other": "b",
    });
  });

  it("keeps other hosts' cursors when one host's page lands", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: cursors,
      firstCursors: cursors,
      firstKeys: new Set<string>(),
      errors: [],
    };
    const sent = issueListCursorsOn(cursors, "github.com");
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
    expect(issueListCursorsOn(refreshed.nextCursors, "github.com")).toEqual({
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
        source: { projectId: "project-1", host: "GitHub.com", scope: "Acme/App" },
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
      { source: { projectId: "project-1", host: "github.com", scope: "acme/app" } },
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
