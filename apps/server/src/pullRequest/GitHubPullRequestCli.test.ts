import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";

const mockedExecute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();

const layer = it.layer(
  GitHubPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(stdout: string, stdoutTruncated = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
  };
}

function pullRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      url: `https://github.com/acme/web/pull/${firstNumber + index}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
    })),
  );
}

function pullRequestFiles(count: number, firstIndex: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}

/** What `gh pr diff` answers on a pull request GitHub will not serve a diff for. */
const diffRefused = new GitHubCli.GitHubCliCommandError({
  command: "gh",
  cwd: "/w",
  cause: new Error("HTTP 406: the diff exceeded the maximum number of files (300)"),
});

/** The whole invocation the nth call made, so both argv and stdin can be asserted. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitHubPullRequestCli.layer", (it) => {
  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const args = callAt(0).args;
      expect(args).toContain("--repo");
      expect(args).toContain("github.com/acme/web");
      expect(args).toContain("--state");
      expect(args).toContain("open");
      expect(args).toContain("--limit");
      expect(args).toContain("11");
    }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("excludes merged pull requests from the Closed tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // `--state closed` includes merged pull requests, so the tab narrows through search.
      expect(callAt(0).args).toContain("is:unmerged");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      const args = callAt(0).args;
      expect(args).toContain("--author");
      expect(args).toContain("bilal");
    }),
  );

  it.effect("narrows through search on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(callAt(0).args).toContain("review-requested:bilal");
    }),
  );

  it.effect("merges with the strategy it was asked for", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(callAt(0).args).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.com/acme/web",
        "--squash",
      ]);
    }),
  );

  it.effect("returns a pull request to draft by undoing ready", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "draft",
      });

      // gh has no `draft` command; going back is `ready --undo`.
      expect(callAt(0).args).toEqual([
        "pr",
        "ready",
        "7",
        "--repo",
        "github.com/acme/web",
        "--undo",
      ]);
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.commentOnPullRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        body: "Looks good.",
      });

      // argv shows up in process listings and in process-runner failure messages.
      expect(callAt(0).args).toEqual([
        "pr",
        "comment",
        "7",
        "--repo",
        "github.com/acme/web",
        "--body-file",
        "-",
      ]);
      expect(callAt(0).stdin).toBe("Looks good.");
      expect(callAt(0).args).not.toContain("Looks good.");
    }),
  );

  it.effect("names the host on every repository it addresses", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // A bare `owner/repo` resolves against github.com, which is a different repository.
      expect(callAt(0).args).toContain("github.acme.dev/acme/web");
    }),
  );

  it.effect("asks a GitHub Enterprise host for its own review threads", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      const args = callAt(0).args;
      expect(args).toContain("--hostname");
      expect(args).toContain("github.acme.dev");
      expect(args).toContain("owner=acme");
      expect(args).toContain("name=web");
    }),
  );

  it.effect("serves a diff GitHub hands over whole in one request, with no next slice", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("diff --git a/a b/a")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      // The common case pays for one request and not the files API on top of it.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      // GitHub answers 406 rather than a diff past 300 changed files.
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      // A short page is the end of the change set, so there is nothing to carry on from.
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      const args = callAt(1).args;
      expect(args).toContain("--hostname");
      expect(args).toContain("github.acme.dev");
      expect(args).toContain("repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // A full page means more files, which the reader asks for; it is not a truncated slice.
      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("carries on from a cursor without asking `gh pr diff` again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("diff --git a/src/file100.ts b/src/file100.ts");
      // The second slice is one request: the cursor already says where to read.
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(callAt(2).args).toContain("repos/acme/web/pulls/7/files?per_page=100&page=2");
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from the commit endpoint rather than from `gh pr diff`", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      // One request: the commit's own changes never take the `gh pr diff` road.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      const args = callAt(0).args;
      expect(args).toContain(
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
      // The commit endpoint wraps its files in an object, which jq unwraps for the decoder.
      expect(args).toContain(".files // []");
    }),
  );

  it.effect("pages inside a commit the way it pages the pull request's own files", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
      };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(callAt(1).args).toContain("repos/acme/web/commits/a1b2c3d?per_page=100&page=2");
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "../../pulls/8/files",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("reports the refused diff when the files API cannot answer either", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("skips the avatar lookup when a listing named nobody", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: [],
      });

      assert.strictEqual(avatars.size, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("fails when the authenticated account has no login", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("  ")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerLogin({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitHubViewerLoginUnavailableError");
    }),
  );

  it.effect("sends a whole review as one request body over stdin", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", line: 4, side: "right", body: "nit" }],
      });

      expect(callAt(0).args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/pulls/7/reviews",
        "--input",
        "-",
      ]);
      // One request, so nothing is on the pull request until the verdict is.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({
        event: "APPROVE",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "nit" }],
      });
    }),
  );

  it.effect("sends a reply body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.replyToReviewThread({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        threadId: "PRRT_1",
        body: "Fixed in 42ff8ec.",
      });

      // A reply is the reader's own words, so it travels the same way a comment body does.
      expect(callAt(0).args).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--input",
        "-",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const request = JSON.parse(callAt(0).stdin ?? "") as {
        query: string;
        variables: Record<string, string>;
      };
      expect(request.query).toContain("addPullRequestReviewThreadReply");
      expect(request.variables).toEqual({ threadId: "PRRT_1", body: "Fixed in 42ff8ec." });
      expect(callAt(0).args.join(" ")).not.toContain("Fixed in 42ff8ec.");
    }),
  );

  it.effect("resolves and unresolves through the mutation each one needs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: true,
      });
      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: false,
      });

      const parse = (index: number) => JSON.parse(callAt(index).stdin ?? "") as { query: string };
      expect(parse(0).query).toContain("resolveReviewThread(");
      expect(parse(1).query).toContain("unresolveReviewThread(");
      // A GitHub Enterprise thread is resolved on its own host, not on github.com.
      expect(callAt(0).args).toContain("github.acme.dev");
    }),
  );

  it.effect("fails the read when gh returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
    }),
  );

  it.effect("fails a files page too large to read rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1), true)));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      // What matters is that it fails at all: an empty patch with no cursor would render as a
      // change with no files and report the rest of it as already read. The refusal that sent
      // the read down this road is the one reported, by design.
      assert.strictEqual(error._tag, "GitHubCliCommandError");
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      // `gh pr diff` succeeded but its output was cut at a byte, which lands mid-file.
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The severed patch is thrown away; what comes back is assembled from whole files.
      expect(callAt(1).args.join(" ")).toContain("/pulls/7/files");
      expect(slice.patch).toContain("src/file1.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );
});
