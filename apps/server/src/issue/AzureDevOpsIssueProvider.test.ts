import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
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
            return Effect.succeed({ linkedPullRequests, linkedPullRequestsTruncated: true });
          },
          listComments: () => Effect.succeed({ comments, commentCount: 150, nextCursor: "next" }),
          listUpdates: () => Effect.succeed({ events, eventsTruncated: false }),
        }),
      ),
    );
    const detail = yield* provider.getIssue(reference);
    assert.deepStrictEqual(detail.linkedPullRequests, linkedPullRequests);
    assert.strictEqual(detail.linkedPullRequestsTruncated, true);
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
      eventsTruncated: false,
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
