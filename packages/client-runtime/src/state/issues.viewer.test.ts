import type {
  EnvironmentId,
  IssueCapabilities,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";
import {
  continueIssueListPage,
  createIssueEnvironmentAtoms,
  issueEntryKey,
  refreshIssueListPage,
} from "./issues.ts";

const row = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry => ({
  tracker: "github" as IssueTrackerKind,
  host: "github.com",
  scope: "acme/app",
  projectId: "app" as ProjectId,
  projectTitle: "App",
  displayKey: `#${key}`,
  title: key,
  url: `https://github.com/acme/app/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  ...overrides,
  key,
});
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

describe("held issue list viewers", () => {
  it.each([cursor, "github.com acme/app"])(
    "drops old private rows and resets %s on a changed or missing viewer",
    (key) => {
      for (const viewer of ["B", null]) {
        const held = loaded(key);
        const fresh = answer([row("B-first")], { [key]: "B2" }, viewer);
        const next = refreshIssueListPage(held, fresh);
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual(fresh.nextCursors);
        expect(next.firstCursors).toEqual(fresh.nextCursors);
        expect(next.firstKeys).toEqual(new Set([issueEntryKey(row("B-first"))]));
      }
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

  it.each(["assigned", "all"] as const)(
    "resets %s rows using only the requested list reads",
    async (involvement) => {
      const supervisor = {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_environmentId, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      );
      const registry = AtomRegistry.make();
      const atoms = createIssueEnvironmentAtoms(runtime);
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
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual({ [cursor]: "B2" });
        expect(request.mock.calls.map(([tag]) => tag)).toEqual([
          "issues.list",
          "issues.list",
          "issues.list",
        ]);
        expect(replies).toEqual([]);
      } finally {
        registry.dispose();
        request.mockRestore();
      }
    },
  );
});
