import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";
import { decodeWorkItemJson, decodeWorkItemsJson } from "./azureDevOpsIssueJson.ts";

it.effect("reads modern and legacy Azure work item URLs in lists and details", () =>
  Effect.gen(function* () {
    for (const [url, expectedUrl] of [
      [
        "https://dev.azure.com/acme/_apis/wit/workItems/7",
        "https://dev.azure.com/acme/_workitems/edit/7",
      ],
      [
        "https://dev.azure.com/acme/web/_apis/wit/workItems/7",
        "https://dev.azure.com/acme/web/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/web/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/web/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/DefaultCollection/web/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/DefaultCollection/web/_workitems/edit/7",
      ],
      [
        "https://azure.example.com/collection/web/_apis/wit/workItems/7",
        "https://azure.example.com/collection/web/_workitems/edit/7",
      ],
    ]) {
      const item = {
        id: 7,
        url,
        fields: {
          "System.Title": "Work item 7",
          "System.CreatedDate": "2026-07-01T00:00:00Z",
          "System.Description": "Work item body",
        },
      };
      const provider = yield* AzureDevOpsIssueProvider.make.pipe(
        Effect.provide(
          AzureDevOpsIssueCli.layer.pipe(
            Layer.provide(NodeFileSystem.layer),
            Layer.provide(SourceControlRateLimit.layer),
            Layer.provide(
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout:
                      args[0] === "repos"
                        ? "web\n"
                        : JSON.stringify(args[1] === "query" ? [item] : item),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              }),
            ),
          ),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com" };
      const page = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 20,
      });
      assert.deepStrictEqual(
        page.items.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url })),
        [{ number: 7, title: "Work item 7", url: expectedUrl }],
      );
      const detail = yield* provider.getIssue({ ...reference, number: 7 });
      assert.strictEqual(detail.url, expectedUrl);
      assert.strictEqual(detail.body, "Work item body");
      assert.strictEqual(detail.linkedPullRequestsTruncated, false);
    }
  }),
);

it("rejects malformed and non-HTTP work item URLs in lists and details", () => {
  for (const url of [
    "not a URL",
    "javascript://acme.visualstudio.com/_apis/wit/workItems/7",
    "https://acme.visualstudio.com.evil.test/_apis/wit/workItems/7",
    "https://dev.azure.com/_apis/wit/workItems/7",
    "https://acme.visualstudio.com/_apis/git/repositories/7",
  ]) {
    const item = {
      id: 7,
      url,
      fields: {
        "System.Title": "Work item 7",
        "System.CreatedDate": "2026-07-01T00:00:00Z",
      },
    };
    assert.deepStrictEqual(
      decodeWorkItemsJson(JSON.stringify([item])),
      Result.succeed({ items: [] }),
    );
    assert.deepStrictEqual(decodeWorkItemJson(JSON.stringify(item)), Result.succeed(null));
  }
});

it.effect("maps CLI rate limits without changing other Azure DevOps failures", () =>
  Effect.gen(function* () {
    const context = {
      operation: "execute" as const,
      command: "az" as const,
      cwd: "/repo",
      argumentCount: 1,
      cause: new Error("provider failure"),
    };
    for (const [source, reason] of [
      [new AzureDevOpsCli.AzureDevOpsCliRateLimitError(context), "rate-limited"],
      [new AzureDevOpsCli.AzureDevOpsCliUnavailableError(context), "missing-tool"],
      [new AzureDevOpsCli.AzureDevOpsCliAuthenticationError(context), "unauthenticated"],
      [new AzureDevOpsCli.AzureDevOpsCommandFailedError(context), "failed"],
    ] as const) {
      const provider = yield* AzureDevOpsIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
            listWorkItems: () => Effect.fail(source),
            runWorkItemAction: () => Effect.fail(source),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com" };
      for (const request of [
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
        provider.runAction({ ...reference, number: 7, action: "close" }),
      ]) {
        const error = yield* Effect.flip(request);
        assert.strictEqual(error._tag, "IssueProviderError");
        assert.strictEqual(error.provider, "azure-devops");
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.retryAt, undefined);
        assert.strictEqual(error.detail, source.detail);
        assert.strictEqual(error.cause, source);
      }
    }
  }),
);

it.effect("returns native PR links and activity without claiming whole-item reactions", () =>
  Effect.gen(function* () {
    const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com", number: 7 };
    const parsed = decodeWorkItemJson(
      JSON.stringify({
        id: 7,
        url: "https://dev.azure.com/acme/web/_apis/wit/workItems/7",
        fields: { "System.Title": "Work item", "System.CreatedDate": "2026-07-01T00:00:00Z" },
        relations: [{ rel: "ArtifactLink", url: "native-artifact" }],
      }),
    );
    assert.isTrue(Result.isSuccess(parsed));
    if (!Result.isSuccess(parsed) || parsed.success === null) return;
    const item = parsed.success;
    const linkedPullRequests = [
      {
        repository: "acme/other/repo",
        number: 8,
        title: "Linked",
        url: "https://dev.azure.com/acme/other/_git/repo/pullrequest/8",
        state: "open" as const,
        isDraft: false,
        closesIssue: false,
      },
    ];
    const comments = [
      {
        id: "5",
        author: null,
        body: "Hello",
        createdAt: "2026-07-01T00:00:00Z",
        url: null,
        reactions: [{ content: "heart" as const, count: 1, actors: [], viewerHasReacted: true }],
      },
    ];
    const events = [
      {
        id: "update-1",
        kind: "closed" as const,
        actor: null,
        createdAt: "2026-07-02T00:00:00Z",
        detail: "Closed",
      },
    ];
    const provider = yield* AzureDevOpsIssueProvider.make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
          getWorkItem: () => Effect.succeed(item),
          listLinkedPullRequests: (input) => {
            assert.deepStrictEqual(input, { ...reference, relations: item.relations ?? [] });
            return Effect.succeed({
              linkedPullRequests,
              linkedPullRequestsTruncated: true,
              nextCursor: "5",
            });
          },
          listComments: () => Effect.succeed({ comments, commentCount: 150, nextCursor: "next" }),
          listUpdates: () => Effect.succeed({ events, eventsTruncated: true, nextCursor: "100" }),
        }),
      ),
    );
    const detail = yield* provider.getIssue(reference);
    assert.deepStrictEqual(detail.linkedPullRequests, linkedPullRequests);
    assert.strictEqual(detail.linkedPullRequestsTruncated, true);
    assert.strictEqual(detail.nextLinkedPullRequestsCursor, "5");
    assert.strictEqual(detail.reactions, undefined);
    assert.strictEqual(provider.capabilities.reactions, false);
    assert.strictEqual(provider.capabilities.commentReactions, true);
    assert.deepStrictEqual(provider.capabilities.reactionContents, [
      "thumbs-up",
      "thumbs-down",
      "heart",
      "hooray",
      "laugh",
      "confused",
    ]);
    assert.strictEqual(provider.capabilities.linkedPullRequests, true);
    assert.strictEqual(provider.capabilities.timelineEvents, true);
    assert.deepStrictEqual(yield* provider.getIssueActivity(reference), {
      comments,
      commentCount: 150,
      commentsTruncated: true,
      nextCommentsCursor: "next",
      events,
      eventsTruncated: true,
      nextEventsCursor: "100",
    });
    assert.deepStrictEqual(
      yield* provider.getIssueComments!({ ...reference, cursor: "previous" }),
      { comments, nextCursor: "next" },
    );
  }),
);

it.effect("maps native reaction refusals and stops whole-item writes before calling Azure", () =>
  Effect.gen(function* () {
    const provider = yield* AzureDevOpsIssueProvider.make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
          setReaction: () =>
            Effect.fail(
              new AzureDevOpsIssueCli.AzureDevOpsIssueInputError({ reason: "comment-required" }),
            ),
        }),
      ),
    );
    const error = yield* Effect.flip(
      provider.setReaction!({
        cwd: "/repo",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
        content: "heart",
        reacted: true,
      }),
    );
    assert.strictEqual(error.operation, "setReaction");
    assert.strictEqual(error.reason, "failed");
    assert.strictEqual(error.detail, "Azure DevOps supports reactions on comments only.");
  }),
);

it.effect("loads PR continuation from fresh native relations with scoped permission reads", () =>
  Effect.gen(function* () {
    const project = "11111111-1111-1111-1111-111111111111";
    const repository = "22222222-2222-2222-2222-222222222222";
    const reference = {
      cwd: "/repo",
      repository: "acme/web/repo",
      host: "dev.azure.com",
      number: 7,
    };
    const relations = Array.from({ length: 21 }, (_, index) => ({
      rel: "ArtifactLink",
      url: `vstfs:///Git/PullRequestId/${project}/${repository}/${index + 1}`,
    }));
    let currentRelations = relations;
    const execute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>(({ args }) => {
      let payload: unknown;
      if (args[0] === "boards") {
        payload = {
          id: 7,
          url: "https://dev.azure.com/acme/web/_apis/wit/workItems/7",
          fields: {
            "System.Title": "Work item",
            "System.CreatedDate": "2026-07-01T00:00:00Z",
          },
          relations: currentRelations,
        };
      } else {
        assert.isTrue(args.includes(`project=${project}`));
        assert.isTrue(args.includes(`repositoryId=${repository}`));
        assert.isTrue(args.includes("https://dev.azure.com/acme"));
        assert.strictEqual(args[args.indexOf("--http-method") + 1], "GET");
        const number = Number(args.find((arg) => arg.startsWith("pullRequestId="))?.slice(14));
        payload = {
          pullRequestId: number,
          title: `PR ${number}`,
          status: "active",
          repository: {
            name: "Other Repo",
            project: { name: "Other Project" },
            webUrl: "https://dev.azure.com/acme/Other%20Project/_git/Other%20Repo",
          },
        };
      }
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: JSON.stringify(payload),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });
    const provider = yield* AzureDevOpsIssueProvider.make.pipe(
      Effect.provide(
        AzureDevOpsIssueCli.layer.pipe(
          Layer.provide(NodeFileSystem.layer),
          Layer.provide(SourceControlRateLimit.layer),
          Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute })),
        ),
      ),
    );
    const initial = yield* provider.getIssue(reference);
    assert.deepStrictEqual(
      initial.linkedPullRequests.map((pr) => pr.number),
      [1, 2, 3, 4, 5],
    );
    assert.strictEqual(initial.nextLinkedPullRequestsCursor, "5");
    assert.strictEqual(execute.mock.calls.length, 6);
    const numbers = initial.linkedPullRequests.map((pr) => pr.number);
    let cursor = initial.nextLinkedPullRequestsCursor;
    while (cursor !== null) {
      const before = execute.mock.calls.length;
      const page = yield* provider.getIssueLinkedPullRequests({ ...reference, cursor });
      assert.strictEqual(execute.mock.calls.length - before, 1 + page.linkedPullRequests.length);
      assert.strictEqual(execute.mock.calls[before]![0].args[0], "boards");
      assert.isTrue(
        page.linkedPullRequests.every(
          (pr) => pr.repository === "acme/Other Project/Other Repo" && !pr.closesIssue,
        ),
      );
      numbers.push(...page.linkedPullRequests.map((pr) => pr.number));
      cursor = page.nextCursor;
      assert.strictEqual(page.truncated, cursor !== null);
    }
    assert.deepStrictEqual(
      numbers,
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    const beforeEnd = execute.mock.calls.length;
    assert.deepStrictEqual(
      yield* provider.getIssueLinkedPullRequests({ ...reference, cursor: "21" }),
      {
        linkedPullRequests: [],
        nextCursor: null,
        truncated: false,
      },
    );
    assert.strictEqual(execute.mock.calls.length - beforeEnd, 1);
    currentRelations = [
      ...relations.slice(0, 5),
      { rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/${project}/${repository}/99` },
    ];
    const fresh = yield* provider.getIssueLinkedPullRequests({ ...reference, cursor: "5" });
    assert.deepStrictEqual(
      fresh.linkedPullRequests.map((pr) => pr.number),
      [99],
    );
    assert.strictEqual(fresh.nextCursor, null);
    assert.isFalse(fresh.truncated);
  }),
);

it.effect("rejects invalid PR cursors before reading the work item", () =>
  Effect.gen(function* () {
    const getWorkItem = vi.fn<AzureDevOpsIssueCli.AzureDevOpsIssueCli["Service"]["getWorkItem"]>();
    const listLinkedPullRequests =
      vi.fn<AzureDevOpsIssueCli.AzureDevOpsIssueCli["Service"]["listLinkedPullRequests"]>();
    const provider = yield* AzureDevOpsIssueProvider.make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
          getWorkItem,
          listLinkedPullRequests,
        }),
      ),
    );
    for (const cursor of ["", "0", "-1", "1.5", "01", "1e2", "2147483648", "9007199254740992"]) {
      const error = yield* Effect.flip(
        provider.getIssueLinkedPullRequests({
          cwd: "/repo",
          repository: "acme/web/repo",
          host: "dev.azure.com",
          number: 7,
          cursor,
        }),
      );
      assert.strictEqual(error.operation, "getIssueLinkedPullRequests");
      assert.strictEqual(error.reason, "failed");
      assert.instanceOf(error.cause, AzureDevOpsIssueCli.AzureDevOpsIssueReadError);
    }
    assert.strictEqual(getWorkItem.mock.calls.length, 0);
    assert.strictEqual(listLinkedPullRequests.mock.calls.length, 0);
  }),
);

it.effect(
  "skips missing PRs while keeping permission, work item, auth and rate-limit failures",
  () =>
    Effect.gen(function* () {
      const reference = {
        cwd: "/repo",
        repository: "acme/web/repo",
        host: "dev.azure.com",
        number: 7,
        cursor: "1",
      };
      const item = {
        id: 7,
        url: "https://dev.azure.com/acme/web/_apis/wit/workItems/7",
        fields: {
          "System.Title": "Work item",
          "System.CreatedDate": "2026-07-01T00:00:00Z",
        },
        relations: [
          { rel: "Hyperlink", url: "https://evil.test" },
          {
            rel: "ArtifactLink",
            url: "vstfs:///Git/PullRequestId/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/8",
          },
        ],
      };
      const context = {
        operation: "execute" as const,
        command: "az" as const,
        cwd: "/repo",
        argumentCount: 1,
        cause: "refused",
      };
      for (const [source, reason, skipPR] of [
        [
          AzureDevOpsCli.AzureDevOpsCommandFailedError.fromVcsError(
            context,
            VcsProcessExitError.fromProcessExit(
              context,
              { exitCode: 1, stderr: "HTTP 403: Forbidden", stderrTruncated: false },
              "command-failed",
            ),
          ),
          "failed",
          false,
        ],
        [
          new AzureDevOpsCli.AzureDevOpsPullRequestNotFoundError({ ...context, cause: "404" }),
          "failed",
          true,
        ],
        [new AzureDevOpsCli.AzureDevOpsCliAuthenticationError(context), "unauthenticated", false],
        [new AzureDevOpsCli.AzureDevOpsCliRateLimitError(context), "rate-limited", false],
        [new AzureDevOpsCli.AzureDevOpsCommandFailedError(context), "failed", false],
      ] as const) {
        for (const denyItem of [false, true]) {
          const execute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>(({ args }) =>
            args[0] === "boards" && !denyItem
              ? Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: JSON.stringify(item),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : Effect.fail(source),
          );
          const provider = yield* AzureDevOpsIssueProvider.make.pipe(
            Effect.provide(
              AzureDevOpsIssueCli.layer.pipe(
                Layer.provide(NodeFileSystem.layer),
                Layer.provide(SourceControlRateLimit.layer),
                Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute })),
              ),
            ),
          );
          if (!denyItem && skipPR) {
            assert.deepStrictEqual(yield* provider.getIssueLinkedPullRequests(reference), {
              linkedPullRequests: [],
              nextCursor: null,
              truncated: false,
            });
          } else {
            const error = yield* Effect.flip(provider.getIssueLinkedPullRequests(reference));
            assert.strictEqual(error.reason, reason);
            assert.strictEqual(error.cause, source);
            assert.strictEqual(error.operation, "getIssueLinkedPullRequests");
          }
          assert.strictEqual(execute.mock.calls.length, denyItem ? 1 : 2);
        }
      }
    }),
);
