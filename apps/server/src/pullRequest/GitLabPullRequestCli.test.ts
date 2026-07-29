import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
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

function mergeRequests(count: number, firstNumber: number): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

/** The endpoint or subcommand of the nth glab invocation. */
function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitLabPullRequestCli.layer", (it) => {
  it.effect("asks GitLab for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("projects/acme%2Fweb/merge_requests");
      expect(path).toContain("per_page=11");
      expect(path).toContain("state=opened");
    }),
  );

  it.effect("walks pages at a fixed size, because GitLab pages by offset", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 1))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 150);
      assert.isTrue(batch.truncated);
      for (const index of [0, 1]) {
        expect(argsOfCall(index)[1]).toContain("per_page=100");
      }
      expect(argsOfCall(0)[1]).toContain("page=1");
      expect(argsOfCall(1)[1]).toContain("page=2");
    }),
  );

  it.effect("stops walking on a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(40, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 40);
      assert.isFalse(batch.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("stops walking when every row on a page fails to decode", () =>
    Effect.gen(function* () {
      // Full pages of unusable rows: nothing is collected, so the collected-count bound never
      // trips and only the page bound can end the walk.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const unusable = JSON.stringify(Array.from({ length: 100 }, () => ({ iid: "nope" })));
      mockedExecute.mockReturnValue(Effect.succeed(output(unusable)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 0);
      // ceil((150 + 1) / 100) pages, not one request per page forever.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("filters by the reviewer when the viewer is reviewing", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("reviewer_username=bilal");
    }),
  );

  it.effect("addresses a nested group project by its encoded full path", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/platform/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("projects/acme%2Fplatform%2Fweb/merge_requests");
    }),
  );

  it.effect("merges immediately rather than leaving auto-merge armed", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(argsOfCall(0)).toEqual([
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/web",
        "--auto-merge=false",
        "--yes",
        "--squash",
      ]);
    }),
  );

  it.effect("moves a merge request back to draft through glab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "draft",
      });

      expect(argsOfCall(0)).toEqual(["mr", "update", "7", "--repo", "acme/web", "--draft"]);
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.commentOnMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        body: "true",
      });

      const call = mockedExecute.mock.calls[0];
      assert.isDefined(call);
      expect(call[0].args).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/notes",
        "--method",
        "POST",
        "--input",
        "-",
      ]);
      // A JSON body, so a comment reading as a literal `true` stays text.
      expect(call[0].stdin).toBe('{"body":"true"}');
    }),
  );

  it.effect("walks diff pages and reports files it had to leave behind", () =>
    Effect.gen(function* () {
      const page = (start: number) =>
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            old_path: `src/${start + index}.ts`,
            new_path: `src/${start + index}.ts`,
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          })),
        );
      mockedExecute.mockReturnValue(Effect.succeed(output(page(0))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      // Three full pages, then it stops and says the change set was cut short.
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      assert.isTrue(diff.truncated);
      expect(argsOfCall(2)[1]).toContain("page=3");
    }),
  );

  it.effect("stops walking diffs on a short page and calls the patch complete", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              { old_path: "src/a.ts", new_path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" },
            ]),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isFalse(diff.truncated);
      expect(diff.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    }),
  );

  it.effect("offers no squash when the project does not say it allows one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ merge_method: "merge" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: true, squash: false, rebase: false });
    }),
  );

  it.effect("reads the project's merge settings as its merge capabilities", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ merge_method: "ff", squash_option: "never" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: false, squash: false, rebase: true });
    }),
  );

  it.effect("fails the read when GitLab returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"404 Not Found"}')));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDetail({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabViewerUnavailableError");
    }),
  );
});
