import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
      }),
    ),
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

function pullRequests(count: number, firstNumber: number): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      pullRequestId: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      status: "active",
      sourceRefName: "refs/heads/feat/page",
      targetRefName: "refs/heads/main",
      creationDate: "2026-07-01T00:00:00Z",
      repository: { name: "web", project: { name: "platform" } },
      url: `https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/${firstNumber + index}`,
    })),
  );
}

/** The arguments of the nth az invocation. */
function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("AzureDevOpsPullRequestCli.layer", (it) => {
  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "list",
        "--detect",
        "true",
        "--repository",
        "web",
        "--status",
        "active",
        "--include-links",
        "--top",
        "11",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("reports truncation from the extra row", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "closed",
        involvement: "authored",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      expect(argsOfCall(0)).toContain("--creator");
      expect(argsOfCall(0)).toContain("bilal@acme.dev");
      // Azure calls a closed pull request abandoned.
      expect(argsOfCall(0)).toContain("abandoned");
    }),
  );

  it.effect("narrows to the reviewer on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      expect(argsOfCall(0)).toContain("--reviewer");
    }),
  );

  it.effect("reads the signed-in account, which az reports as a bare value", () =>
    Effect.gen(function* () {
      // `--query user` unwraps the object, so the wrapper has to put it back.
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ name: "bilal@acme.dev", type: "user" }))),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const viewer = yield* cli.getViewer({ cwd: "/w" });

      assert.strictEqual(viewer, "bilal@acme.dev");
      expect(argsOfCall(0)).toEqual([
        "account",
        "show",
        "--query",
        "user",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("fails when nobody is signed in", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));

      assert.strictEqual(error._tag, "AzureDevOpsViewerUnavailableError");
    }),
  );

  it.effect("completes a pull request to merge it, squashing only when asked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        number: 42,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        "--status",
        "completed",
        "--squash",
        "true",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect.each([
    { action: "draft", expected: ["--draft", "true"] },
    { action: "ready", expected: ["--draft", "false"] },
    { action: "close", expected: ["--status", "abandoned"] },
    { action: "reopen", expected: ["--status", "active"] },
  ] as const)("moves a pull request with $action", ({ action, expected }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.runPullRequestAction({ cwd: "/w", number: 42, action });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        ...expected,
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("reads the conversation through the REST API, pinned to a version", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              value: [
                {
                  id: 1,
                  comments: [
                    { id: 1, content: "Looks good.", publishedDate: "2026-07-02T00:00:00Z" },
                  ],
                },
              ],
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const comments = yield* cli.listThreads({
        cwd: "/w",
        threadsUrl: "https://dev.azure.com/acme/platform/_apis/git/r/web/pullRequests/42/threads",
      });

      assert.strictEqual(comments.length, 1);
      expect(argsOfCall(0)).toContain("rest");
      expect(argsOfCall(0)).toContain(
        "https://dev.azure.com/acme/platform/_apis/git/r/web/pullRequests/42/threads?api-version=7.1",
      );
    }),
  );

  it.effect("reports a pull request it cannot place as its own outcome", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // Well-formed, but with nothing to build a link from: not a decode failure.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              pullRequestId: 42,
              title: "Add the page",
              sourceRefName: "refs/heads/feat/page",
              targetRefName: "refs/heads/main",
              creationDate: "2026-07-01T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestIncompleteError");
    }),
  );

  it.effect("fails the read when az returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestReadError");
    }),
  );
});
