import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsIssueCli.layer.pipe(
    Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute: mockedExecute })),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function workItem(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
    fields: {
      "System.Title": `Work item ${id}`,
      "System.State": "Active",
      "System.CreatedDate": "2026-07-01T00:00:00Z",
      "System.ChangedDate": "2026-07-02T00:00:00Z",
      ...overrides,
    },
  };
}

/** Answers the project lookup every listing makes first, then the query itself. */
function listing(items: ReadonlyArray<unknown>, project = "web") {
  mockedExecute.mockImplementation(
    (input) =>
      Effect.succeed(
        output(input.args[0] === "repos" ? `${project}\n` : JSON.stringify(items)),
      ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>,
  );
}

const wiqlOf = () => {
  const call = mockedExecute.mock.calls.find(([input]) => input.args[0] === "boards");
  assert.isDefined(call);
  const args = call[0].args;
  return args[args.indexOf("--wiql") + 1] ?? "";
};

afterEach(() => {
  mockedExecute.mockReset();
});

layer((it) => {
  it.effect("names the project in the query, because az boards runs at the organization", () =>
    Effect.gen(function* () {
      listing([workItem(1)], "Fabrikam Web");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "open", involvement: "all", limit: 30 });

      // `@project` resolves to nothing here, so the query would otherwise answer for every
      // project in the organization.
      expect(wiqlOf()).toContain("[System.TeamProject] = 'Fabrikam Web'");
      expect(wiqlOf()).not.toContain("@project");
    }),
  );

  it.effect("asks az for the project the checkout belongs to", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "all", involvement: "all", limit: 30 });

      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "repos",
        "show",
        "--detect",
        "true",
        "--query",
        "project.name",
        "--only-show-errors",
        "--output",
        "tsv",
      ]);
    }),
  );

  it.effect("fails rather than answering the whole organization when az names no project", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        () =>
          Effect.succeed(output("  \n")) as ReturnType<
            AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
          >,
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.listWorkItems({ cwd: "/w", state: "open", involvement: "all", limit: 30 }),
      );

      assert.strictEqual(error._tag, "AzureDevOpsIssueReadError");
    }),
  );

  it.effect("narrows by state and by who a work item belongs to", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "open", involvement: "assigned", limit: 30 });

      expect(wiqlOf()).toContain("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')");
      expect(wiqlOf()).toContain("[System.AssignedTo] = @Me");
    }),
  );

  it.effect("answers a mention unnarrowed, which Azure records nothing about", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "all", involvement: "mentioned", limit: 30 });

      expect(wiqlOf()).not.toContain("@Me");
    }),
  );

  it.effect("carries on from the instant a cursor names, escaping the quote WIQL has", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z' OR [System.Id] > 0 --", delivered: 1 },
      });

      expect(wiqlOf()).toContain(
        "[System.ChangedDate] <= '2026-07-02T00:00:00Z'' OR [System.Id] > 0 --'",
      );
    }),
  );

  it.effect("keeps the extra row it probed with out of the page it hands over", () =>
    Effect.gen(function* () {
      listing([workItem(1), workItem(2), workItem(3)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 2],
      );
      assert.isTrue(page.truncated);
    }),
  );

  it.effect("skips a work item it cannot place rather than losing the page with it", () =>
    Effect.gen(function* () {
      listing([workItem(1), { id: 2, url: null, fields: null }, workItem(3)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 3],
      );
    }),
  );

  it.effect("turns the api link into the board page a reader can actually open", () =>
    Effect.gen(function* () {
      listing([workItem(7)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.strictEqual(page.items[0]?.url, "https://dev.azure.com/acme/_workitems/edit/7");
    }),
  );

  it.effect("reads a project's own closed states as closed", () =>
    Effect.gen(function* () {
      listing([workItem(1, { "System.State": "Done" }), workItem(2, { "System.State": "Doing" })]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.state),
        ["closed", "open"],
      );
    }),
  );

  it.effect("writes a state, which is all Azure has in place of closing and reopening", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        () =>
          Effect.succeed(output("{}")) as ReturnType<
            AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
          >,
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" });

      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "boards",
        "work-item",
        "update",
        "--id",
        "7",
        "--state",
        "Closed",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );
});
