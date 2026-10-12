import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { VcsProcessExitError } from "@t3tools/contracts";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsIssueCli.layer.pipe(
    Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute: mockedExecute })),
    Layer.provide(NodeFileSystem.layer),
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

/** The one rule error az reports for a state a project's workflow does not have. */
const ruleError = (argumentCount: number) =>
  new AzureDevOpsCli.AzureDevOpsCommandFailedError({
    operation: "execute",
    command: "az",
    cwd: "/w",
    argumentCount,
    cause: new VcsProcessExitError({
      operation: "execute",
      command: "az",
      cwd: "/w",
      exitCode: 1,
      detail: "Process exited with a non-zero status.",
      failureKind: "state-rule",
    }),
  });

/** A project whose workflow has only the states named: every other write is refused. */
function acceptsStates(...accepted: ReadonlyArray<string>) {
  mockedExecute.mockImplementation((input) => {
    const state = input.args[input.args.indexOf("--state") + 1] ?? "";
    return (
      accepted.includes(state)
        ? Effect.succeed(output("{}"))
        : Effect.fail(ruleError(input.args.length))
    ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>;
  });
}

const updateArgs = (state: string) => [
  "boards",
  "work-item",
  "update",
  "--detect",
  "true",
  "--id",
  "7",
  "--state",
  state,
  "--only-show-errors",
  "--output",
  "json",
];

const statesWritten = () =>
  mockedExecute.mock.calls.map(([input]) => input.args[input.args.indexOf("--state") + 1]);

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
  const target = { cwd: "/w", host: "dev.azure.com", repository: "other/Project One/repo" };

  it.effect(
    "reads the selected organization's viewer from detached or other-provider checkouts",
    () =>
      Effect.gen(function* () {
        const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
        for (const cwd of ["/detached", "/github-checkout"]) {
          mockedExecute.mockReturnValue(Effect.succeed(output('"selected@example.com"')));
          assert.strictEqual(yield* cli.getViewer({ ...target, cwd }), "selected@example.com");
          const args = mockedExecute.mock.calls.at(-1)?.[0].args;
          expect(args).toContain("https://dev.azure.com/other");
          expect(args).toContain("false");
          expect(args).not.toContain("true");
        }
      }),
  );

  it.effect("uses the selected Azure organization and project instead of the checkout", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(JSON.stringify([workItem(7)]))));
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      yield* cli.listWorkItems({
        ...target,
        state: "all",
        involvement: "all",
        limit: 20,
        query: "O'Brien",
      });
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(mockedExecute.mock.calls[0]?.[0].args).toContain("https://dev.azure.com/other");
      expect(mockedExecute.mock.calls[0]?.[0].args).not.toContain("true");
      expect(wiqlOf()).toContain("[System.TeamProject] = 'Project One'");
      expect(wiqlOf()).toContain("[System.Title] CONTAINS 'O''Brien'");
    }),
  );

  it.effect("reads a small status summary with its project URL from an organization API URL", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            JSON.stringify({
              id: 7,
              url: "https://dev.azure.com/other/_apis/wit/workItems/7",
              fields: {
                "System.Title": "Small summary",
                "System.State": "Done",
                "System.TeamProject": "Project One",
              },
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      assert.deepStrictEqual(yield* cli.getWorkItemSummary({ ...target, number: 7 }), {
        number: 7,
        title: "Small summary",
        state: "closed",
        url: "https://dev.azure.com/other/Project%20One/_workitems/edit/7",
      });
      expect(mockedExecute.mock.calls[0]?.[0].args).toContain(
        "System.Title,System.State,System.TeamProject",
      );
      expect(mockedExecute.mock.calls[0]?.[0].args).toContain("https://dev.azure.com/other");
    }),
  );

  it.effect("scopes work item reads and state changes on modern and legacy hosts", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(output(JSON.stringify(workItem(7, { "System.Tags": "bug; customer" })))),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      for (const [host, organization] of [
        ["dev.azure.com", "https://dev.azure.com/other"],
        ["other.visualstudio.com", "https://other.visualstudio.com"],
      ] as const) {
        const ref = { ...target, host, number: 7 };
        const item = yield* cli.getWorkItem(ref);
        assert.deepStrictEqual(item.labels, [
          { name: "bug", color: null },
          { name: "customer", color: null },
        ]);
        yield* cli.runWorkItemAction({ ...ref, action: "close" });
        for (const [request] of mockedExecute.mock.calls.slice(-2)) {
          expect(request.args).toContain(organization);
          expect(request.args).toContain("false");
          expect(request.args).not.toContain("true");
        }
      }
    }),
  );

  it.effect("preserves Markdown descriptions and the work item project in returned links", () =>
    Effect.gen(function* () {
      const description = "**Keep Markdown**\n\n`<T>` & text";
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            JSON.stringify({
              ...workItem(7, {
                "System.TeamProject": "Project One",
                "System.Description": description,
              }),
              multilineFieldsFormat: { "System.Description": "Markdown" },
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const item = yield* cli.getWorkItem({ ...target, number: 7 });
      assert.strictEqual(item.description, description);
      assert.strictEqual(item.url, "https://dev.azure.com/acme/Project%20One/_workitems/edit/7");
    }),
  );

  it.effect(
    "creates the selected type with one assignee, tags, and Markdown in a private request file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let request: unknown;
        let requestFile = "";
        mockedExecute.mockImplementation(({ args }) =>
          Effect.gen(function* () {
            requestFile = args[args.indexOf("--in-file") + 1]!;
            request = JSON.parse(yield* fs.readFileString(requestFile));
            return output(JSON.stringify(workItem(7, { "System.TeamProject": "Project One" })));
          }).pipe(Effect.orDie),
        );
        const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
        assert.deepStrictEqual(
          yield* cli.createWorkItem({
            ...target,
            title: "Create chosen type",
            body: "**Keep Markdown**",
            labels: ["bug", "customer"],
            assignees: ["ada@example.com"],
            workItemType: "User Story",
          }),
          { number: 7, url: "https://dev.azure.com/acme/Project%20One/_workitems/edit/7" },
        );
        assert.deepStrictEqual(request, [
          { op: "add", path: "/fields/System.Title", value: "Create chosen type" },
          { op: "add", path: "/fields/System.Description", value: "**Keep Markdown**" },
          { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
          { op: "add", path: "/fields/System.Tags", value: "bug; customer" },
          { op: "add", path: "/fields/System.AssignedTo", value: "ada@example.com" },
        ]);
        const createArgs = mockedExecute.mock.calls[0]?.[0].args ?? [];
        expect(createArgs).toContain("type=User Story");
        expect(createArgs).toContain("id=$User Story");
        const routes = Object.fromEntries(
          createArgs
            .slice(
              createArgs.indexOf("--route-parameters") + 1,
              createArgs.indexOf("--api-version"),
            )
            .map((parameter) => parameter.split("=")),
        );
        assert.strictEqual(`/workitems/$${routes.type}`, `/workitems/${routes.id}`);
        expect(mockedExecute.mock.calls[0]?.[0].args).toContain("project=Project One");
        expect(mockedExecute.mock.calls[0]?.[0].args).not.toContain("**Keep Markdown**");
        assert.isFalse(yield* fs.exists(requestFile));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "refuses a missing type, multiple assignees, and unrepresentable tags before any request",
    () =>
      Effect.gen(function* () {
        const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
        for (const input of [
          { title: "No type", body: "", labels: [], assignees: [] },
          {
            title: "Too many",
            body: "",
            labels: [],
            assignees: ["ada", "bob"],
            workItemType: "Task",
          },
          { title: "Bad tag", body: "", labels: ["one;two"], assignees: [], workItemType: "Task" },
          { title: "Bad tag", body: "", labels: ["one,two"], assignees: [], workItemType: "Task" },
          {
            title: "Long tag",
            body: "",
            labels: ["x".repeat(401)],
            assignees: [],
            workItemType: "Task",
          },
        ])
          assert.strictEqual(
            (yield* Effect.flip(cli.createWorkItem({ ...target, ...input })))._tag,
            "AzureDevOpsIssueInputError",
          );
        assert.strictEqual(
          (yield* Effect.flip(
            cli.updateWorkItem({ ...target, number: 7, assignees: ["ada", "bob"] }),
          ))._tag,
          "AzureDevOpsIssueInputError",
        );
        assert.strictEqual(mockedExecute.mock.calls.length, 0);
      }),
  );

  it.effect("clears a description, tags, and assignment without changing other fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let request: unknown;
      mockedExecute.mockImplementation(({ args }) =>
        Effect.gen(function* () {
          request = JSON.parse(yield* fs.readFileString(args[args.indexOf("--in-file") + 1]!));
          return output(JSON.stringify({ value: [{ code: 200, body: "{}" }] }));
        }).pipe(Effect.orDie),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      yield* cli.updateWorkItem({ ...target, number: 7, body: "", labels: [], assignees: [] });
      assert.deepStrictEqual(request, [
        {
          method: "PATCH",
          uri: "/Project%20One/_apis/wit/workitems/7?api-version=7.1",
          headers: { "Content-Type": "application/json-patch+json" },
          body: [
            { op: "add", path: "/fields/System.Description", value: "" },
            { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
            { op: "add", path: "/fields/System.Tags", value: "" },
            { op: "add", path: "/fields/System.AssignedTo", value: "" },
          ],
        },
      ]);
      const args = mockedExecute.mock.calls[0]?.[0].args ?? [];
      expect(args).toContain("batch");
      expect(args).toContain("4.1");
      expect(args).not.toContain("workitems");
      expect(mockedExecute.mock.calls[0]?.[0].args).toContain("https://dev.azure.com/other");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reports failed and incomplete inner batch updates as failures", () =>
    Effect.gen(function* () {
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      for (const statusCode of [400, 401, 404, 429]) {
        mockedExecute.mockReturnValue(
          Effect.succeed(
            output(
              JSON.stringify({ value: [{ code: statusCode, body: '{"message":"Refused"}' }] }),
            ),
          ),
        );
        const error = yield* Effect.flip(
          cli.updateWorkItem({ ...target, number: 7, title: "Title" }),
        );
        assert.strictEqual(error._tag, "AzureDevOpsIssueMutationRefusedError");
        assert.strictEqual(error.detail, "Refused");
      }
      for (const response of [{ value: [] }, { value: [{ code: 200 }] }, {}]) {
        mockedExecute.mockReturnValue(Effect.succeed(output(JSON.stringify(response))));
        const error = yield* Effect.flip(
          cli.updateWorkItem({ ...target, number: 7, title: "Title" }),
        );
        assert.strictEqual(error._tag, "AzureDevOpsIssueReadError");
      }
    }),
  );

  it.effect("reads bounded comments and keeps the opaque continuation token", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            JSON.stringify(
              args[0] === "boards"
                ? workItem(7, { "System.TeamProject": "Project One" })
                : {
                    totalCount: 200,
                    continuationToken: " opaque=next&value ",
                    comments: [
                      {
                        id: 1,
                        text: "First",
                        createdDate: "2026-07-01T00:00:00Z",
                        createdBy: { uniqueName: "ada@example.com", displayName: "Ada" },
                      },
                      {
                        commentId: 2,
                        text: "Deleted",
                        createdDate: "2026-07-01T00:00:00Z",
                        isDeleted: true,
                      },
                    ],
                  },
            ),
          ),
        ),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const page = yield* cli.listComments({
        ...target,
        number: 7,
        cursor: "opaque=previous&value",
      });
      assert.strictEqual(page.comments.length, 1);
      assert.strictEqual(page.comments[0]?.id, "1");
      assert.strictEqual(page.commentCount, 200);
      assert.strictEqual(page.nextCursor, " opaque=next&value ");
      const args = mockedExecute.mock.calls[1]?.[0].args ?? [];
      expect(args).toContain("$top=100");
      expect(args).toContain("continuationToken=opaque=previous&value");
      expect(args).toContain("project=Project One");
      expect(args).toContain("https://dev.azure.com/other");
      expect(args).toContain("7.1-preview");
    }),
  );

  it.effect("posts and edits comments as Markdown and cleans request files after failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const failure = new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 10,
        cause: new Error("not signed in"),
      });
      let requestFile = "";
      mockedExecute.mockImplementation(({ args }) =>
        args[0] === "boards"
          ? Effect.succeed(
              output(JSON.stringify(workItem(7, { "System.TeamProject": "Project One" }))),
            )
          : Effect.gen(function* () {
              requestFile = args[args.indexOf("--in-file") + 1]!;
              assert.deepStrictEqual(
                JSON.parse(yield* fs.readFileString(requestFile).pipe(Effect.orDie)),
                { text: "**New comment**" },
              );
              return yield* Effect.fail(failure);
            }),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      for (const commentId of [undefined, "5"]) {
        assert.strictEqual(
          yield* Effect.flip(
            cli.comment({
              ...target,
              number: 7,
              body: "**New comment**",
              ...(commentId === undefined ? {} : { commentId }),
            }),
          ),
          failure,
        );
        assert.isFalse(yield* fs.exists(requestFile));
        const args = mockedExecute.mock.calls.at(-1)?.[0].args ?? [];
        expect(args).toContain(commentId === undefined ? "POST" : "PATCH");
        expect(args).toContain("format=markdown");
      }
      const calls = mockedExecute.mock.calls.length;
      assert.strictEqual(
        (yield* Effect.flip(
          cli.comment({ ...target, number: 7, body: "x", commentId: "1&evil=2" }),
        ))._tag,
        "AzureDevOpsIssueInputError",
      );
      assert.strictEqual(mockedExecute.mock.calls.length, calls);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "lists enabled work item types and retains applied tags absent from the candidate response",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              JSON.stringify(
                args[0] === "boards"
                  ? workItem(7, {
                      "System.TeamProject": "Project One",
                      "System.Tags": "legacy; bug",
                    })
                  : args.includes("workitemtypes")
                    ? {
                        value: [
                          { name: "Task" },
                          { name: "Legacy", isDisabled: true },
                          { name: "User Story", isDisabled: false },
                        ],
                      }
                    : { value: [{ name: "bug" }, { name: "feature" }] },
              ),
            ),
          ),
        );
        const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
        assert.deepStrictEqual(yield* cli.listWorkItemTypes(target), ["Task", "User Story"]);
        const page = yield* cli.listTagCandidates({ ...target, number: 7 });
        assert.deepStrictEqual(
          page.candidates.map((tag) => [tag.name, tag.isApplied]),
          [
            ["bug", true],
            ["feature", false],
            ["legacy", true],
          ],
        );
        assert.isFalse(page.truncated);
      }),
  );

  it.effect("keeps the current assignee in a bounded and deduplicated team candidate list", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            JSON.stringify(
              args[0] === "boards"
                ? workItem(7, {
                    "System.TeamProject": "Project One",
                    "System.AssignedTo": { uniqueName: "current@example.com" },
                  })
                : args.includes("list-member")
                  ? [
                      { identity: { uniqueName: "ada@example.com", displayName: "Ada" } },
                      { identity: { uniqueName: "ADA@example.com" } },
                      { identity: { uniqueName: "group", isContainer: true } },
                    ]
                  : [{ id: "team" }],
            ),
          ),
        ),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const page = yield* cli.listAssigneeCandidates({ ...target, number: 7 });
      assert.deepStrictEqual(
        page.candidates.map((actor) => [actor.id, actor.isAssigned]),
        [
          ["current@example.com", true],
          ["ada@example.com", false],
        ],
      );
      assert.isTrue(page.truncated);
      expect(
        mockedExecute.mock.calls.find(([input]) => input.args.includes("list-member"))?.[0].args,
      ).toContain("100");
    }),
  );

  it.effect("fills a page after unreadable rows without unsupported CLI options", () =>
    Effect.gen(function* () {
      listing([workItem(1), { id: 2 }, { id: 3 }, workItem(4), workItem(5)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 4],
      );
      assert.isTrue(page.truncated);
      expect(wiqlOf()).toContain("[System.Title]");
      expect(wiqlOf()).toContain("[System.CreatedDate]");
      expect(wiqlOf()).toContain("[System.ChangedDate]");
      expect(mockedExecute.mock.calls[1]?.[0].args).not.toContain("--top");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("excludes delivered rows without skipping unseen rows at the same instant", () =>
    Effect.gen(function* () {
      listing([workItem(3)]);
      const provider = yield* AzureDevOpsIssueProvider.make;
      const page = yield* provider.listIssues({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        state: "all",
        involvement: "all",
        viewer: "me",
        limit: 2,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", seenAt: [1, 2] },
      });
      expect(wiqlOf()).toContain("[System.ChangedDate] <= '2026-07-02T00:00:00Z'");
      expect(wiqlOf()).toContain("[System.Id] NOT IN (1,2)");
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [3],
      );
      assert.isFalse(page.truncated);
    }),
  );

  it.effect.each(
    (
      [
        ["created", "CreatedDate"],
        ["updated", "ChangedDate"],
        ["comments", "CommentCount"],
      ] as const
    ).flatMap(([sort, field]) =>
      (["asc", "desc"] as const).map((order) => ({ sort, field, order })),
    ),
  )("orders by $sort $order before limiting the page", ({ sort, field, order }) =>
    Effect.gen(function* () {
      listing([workItem(1, { "System.CommentCount": 9 })]);
      const provider = yield* AzureDevOpsIssueProvider.make;
      const page = yield* provider.listIssues({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        state: "all",
        involvement: "all",
        viewer: "me",
        limit: 2,
        sort,
        order,
      });
      expect(wiqlOf()).toContain(`ORDER BY [System.${field}] ${order.toUpperCase()}`);
      expect(page.items[0]?.commentCount).toBe(9);
    }),
  );

  it.effect("reads the DevOps profile without requiring an Azure subscription", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output('"pat-user@example.com"')));
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      assert.strictEqual(yield* cli.getViewer({ cwd: "/w" }), "pat-user@example.com");
      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "profile",
        "--resource",
        "profiles",
        "--route-parameters",
        "id=me",
        "--api-version",
        "7.1",
        "--query",
        "emailAddress || displayName || id",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("detects the checkout when reading one work item", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(JSON.stringify(workItem(7)))));
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      assert.strictEqual((yield* cli.getWorkItem({ cwd: "/w", number: 7 })).number, 7);
      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "boards",
        "work-item",
        "show",
        "--detect",
        "true",
        "--id",
        "7",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("accepts the null response for an empty WIQL result", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(output(input.args[0] === "repos" ? "web" : "null")),
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });
      assert.deepStrictEqual(page, { items: [], truncated: false });
    }),
  );

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

      assert.strictEqual(error._tag, "AzureDevOpsProjectUnknownError");
      // az itself succeeded, so there is no underlying failure to report as the cause.
      assert.isFalse("cause" in error);
      assert.strictEqual(
        error.message,
        "Azure CLI failed in resolveProject: Azure DevOps named no project for this checkout.",
      );
    }),
  );

  it.effect("says what failed once, rather than stacking the same sentence twice", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        (input) =>
          Effect.succeed(output(input.args[0] === "repos" ? "web\n" : "not json")) as ReturnType<
            AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
          >,
      );
      const provider = yield* AzureDevOpsIssueProvider.make;

      const error = yield* Effect.flip(
        provider.listIssues({
          cwd: "/w",
          repository: "acme/web",
          host: "dev.azure.com",
          state: "all",
          involvement: "all",
          viewer: "someone",
          limit: 30,
        }),
      );

      assert.strictEqual(
        error.message,
        "azure-devops failed in listIssues: Azure CLI returned an unreadable listWorkItems response.",
      );
    }),
  );

  it.effect("offers continuation only for newest-first updated work items", () =>
    Effect.gen(function* () {
      listing([workItem(1)]);
      const provider = yield* AzureDevOpsIssueProvider.make;
      for (const [sort, order, continues] of [
        [undefined, undefined, true],
        [undefined, "asc", false],
        [undefined, "desc", true],
        ["updated", undefined, true],
        ["updated", "asc", false],
        ["updated", "desc", true],
        ["created", undefined, false],
        ["created", "asc", false],
        ["created", "desc", false],
        ["comments", undefined, false],
        ["comments", "asc", false],
        ["comments", "desc", false],
      ] as const) {
        const page = yield* provider.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          repository: "acme/web",
          state: "all",
          involvement: "all",
          viewer: "viewer",
          limit: 1,
          sort,
          order,
        });
        assert.strictEqual(page.continues, continues);
      }
    }),
  );

  it.effect("narrows by state and by who a work item belongs to", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "open", involvement: "assigned", limit: 30 });

      expect(wiqlOf()).toContain(
        "[System.State] NOT IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')",
      );
      expect(wiqlOf()).toContain("[System.AssignedTo] = @Me");
    }),
  );

  it.effect("asks for the same closed states the decoder reads back as closed", () =>
    Effect.gen(function* () {
      listing([workItem(1, { "System.State": "Completed" })]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "closed",
        involvement: "all",
        limit: 30,
      });

      expect(wiqlOf()).toContain(
        "[System.State] IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')",
      );
      // A state the query calls open and the decoder calls closed lands in the open list and is
      // then shown as closed there.
      assert.strictEqual(page.items[0]?.state, "closed");
    }),
  );

  it.effect("refuses a mention filter rather than answering with the whole project", () =>
    Effect.gen(function* () {
      listing([workItem(1)]);
      const provider = yield* AzureDevOpsIssueProvider.make;

      const error = yield* Effect.flip(
        provider.listIssues({
          cwd: "/w",
          repository: "acme/web",
          host: "dev.azure.com",
          state: "all",
          involvement: "mentioned",
          viewer: "someone",
          limit: 30,
        }),
      );

      assert.strictEqual(
        error.detail,
        "Azure DevOps records no mention of a person on a work item.",
      );
      // Azure was asked nothing, because there is no question here it could have answered.
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
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
        cursor: { updatedBefore: "2026-07-02T00:00:00Z' OR [System.Id] > 0 --" },
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
      acceptsStates("Closed");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" });

      // Agile and CMMI spell it `Closed`, and are asked first: those projects cost one write.
      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([input]) => input.args),
        [updateArgs("Closed")],
      );
    }),
  );

  it.effect("moves on to the name the next process template uses when Azure refuses one", () =>
    Effect.gen(function* () {
      acceptsStates("Done");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" });

      // A Scrum or Basic project has no `Closed` state, and nothing in az boards says so: the
      // documented name it does have is written next.
      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([input]) => input.args),
        [updateArgs("Closed"), updateArgs("Done")],
      );
    }),
  );

  it.effect("names every state it tried, which a bare command failure does not", () =>
    Effect.gen(function* () {
      acceptsStates();
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.runWorkItemAction({ cwd: "/w", number: 7, action: "reopen" }),
      );

      // Every out-of-the-box name was refused, so this project runs a custom template: the list is
      // what tells its owner which state of their own belongs here.
      assert.strictEqual(error._tag, "AzureDevOpsWorkItemStateRefusedError");
      expect(error.message).toContain(
        "refused every state that would reopen work item 7: Active, Committed, Doing, To Do, New, Proposed",
      );
      assert.deepStrictEqual(statesWritten(), [
        "Active",
        "Committed",
        "Doing",
        "To Do",
        "New",
        "Proposed",
      ]);
    }),
  );

  it.effect("does not retry unrelated command failures as state changes", () =>
    Effect.gen(function* () {
      const failure = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 9,
        cause: new Error("connection lost"),
      });
      mockedExecute.mockReturnValue(Effect.fail(failure));
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;
      const error = yield* Effect.flip(
        cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" }),
      );
      assert.strictEqual(error, failure);
      assert.deepStrictEqual(statesWritten(), ["Closed"]);
    }),
  );

  it.effect("writes no second state where az answered that it is not signed in", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        (input) =>
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: input.args.length,
              cause: new Error("az devops login"),
            }),
          ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>,
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" }),
      );

      // Nothing about the state was wrong, so another name would fail the same way and bury the
      // one answer that tells the reader what to do.
      assert.strictEqual(error._tag, "AzureDevOpsCliAuthenticationError");
      assert.deepStrictEqual(statesWritten(), ["Closed"]);
    }),
  );
});
