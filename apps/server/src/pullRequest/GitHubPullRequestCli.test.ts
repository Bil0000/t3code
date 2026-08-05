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

/** One thread's comments as the GraphQL read returns them, cursor and all. */
function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({ id, body: id, createdAt: "2026-07-01T00:00:00Z" })),
  };
}

function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}

function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
        },
      },
    },
  });
}

function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
): string {
  return JSON.stringify({
    data: { node: { comments: threadComments(ids, endCursor, totalCount) } },
  });
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

/** The one argument `--search` carries, which is where every listing filter ends up. */
function searchOfCall(index: number): string | undefined {
  const args = callAt(index).args;
  const flag = args.indexOf("--search");
  // Absent is its own answer: a read that carries no `--search` at all is what the fallback is.
  return flag === -1 ? undefined : args[flag + 1];
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
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
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
      expect(searchOfCall(0)).toBe("is:unmerged sort:updated-desc");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
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
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
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

      expect(searchOfCall(0)).toBe("review-requested:bilal sort:updated-desc");
    }),
  );

  it.effect("hands a search to GitHub rather than to the rows already read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
      });

      // The recency qualifier rides along, because free text would otherwise reorder the page
      // by relevance and truncation would drop the newest matches.
      expect(searchOfCall(0)).toBe('"pull requests page" sort:updated-desc');
    }),
  );

  it.effect("joins a search onto the tab's own qualifiers instead of replacing them", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      // One `--search` is all gh reads, so a second would silently drop the first.
      const args = callAt(0).args;
      assert.strictEqual(args.filter((arg) => arg === "--search").length, 1);
      expect(searchOfCall(0)).toBe('review-requested:bilal is:unmerged "page" sort:updated-desc');
    }),
  );

  it.effect("quotes a search, so it cannot add a qualifier or a flag of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-- is:merged label:secret "widen me"',
      });

      // Every word stays inside one phrase: nothing before it, nothing after it, and the
      // leading dashes are text rather than the start of another argument.
      expect(searchOfCall(0)).toBe(
        String.raw`"-- is:merged label:secret \"widen me\"" sort:updated-desc`,
      );
      expect(callAt(0).args).not.toContain("is:merged");
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: String.raw`a\" is:merged`,
      });

      // GitHub reads `\\` as one backslash and `\"` as one quote, so the phrase ends where
      // this says it does; escaping the quote alone would have closed it early.
      expect(searchOfCall(0)).toBe(String.raw`"a\\\" is:merged" sort:updated-desc`);
    }),
  );

  it.effect("asks for nothing but the order when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      // An empty phrase would match nothing rather than everything, so it is left out; the
      // order the page reads rows in is asked for whether or not anything was typed.
      expect(searchOfCall(0)).toBe("sort:updated-desc");
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // Inclusive, so the rows already sent at that instant come back for the caller to drop —
      // which is what keeps the ones beside them from being skipped.
      expect(searchOfCall(0)).toBe("updated:<=2026-07-02T00:00:00Z sort:updated-desc");
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
      // The fallback is for a repository the index does not cover. Under a text search an empty
      // answer means the text matched nothing, and listing everything instead would fill the
      // page with rows the reader did not search for.
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "fdsfklj",
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("reads a repository GitHub will not search the way gh lists one", () =>
    Effect.gen(function* () {
      // GitHub answers for a repository outside its search index with no rows and no error.
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      // Nothing of the search survives the fallback, not even the tab's own qualifier: this read
      // happens precisely because search answered nothing here, and `is:unmerged` is a search
      // too. Those rows arrive in gh's own order, so nothing can carry on from them.
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("takes an empty slice for a repository that has run out, not one to read again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // A repository that answered the search once answers it again, so an empty slice under a
      // cursor is the end of it rather than a repository search cannot reach.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
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
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
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

  it.effect("follows the cursor to the review threads the first page left behind", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_2", "c2")], null))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The first page asks from the beginning, which gh only sends as a typed JSON null.
      expect(callAt(0).args).toContain("cursor=null");
      expect(callAt(1).args).toContain("cursor=Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // A host that never runs out of pages: the walk has to end itself.
      mockedExecute.mockReturnValue(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(conversation.truncated);
    }),
  );

  it.effect("finishes a thread longer than one page from the thread's own node", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              null,
            ),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["c2", "c3"], null, 3))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(callAt(1).args).toContain("threadId=PRRT_1");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2", "c3"]);
      // GitHub's own count, which is what the page shows however much of it was read.
      assert.strictEqual(conversation.commentCount, 3);
    }),
  );

  it.effect(
    "asks for the reader's standing on the repository and on the pull request at once",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                data: {
                  repository: {
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

        const access = yield* cli.getViewerAccess({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });

        // One request, because both answers hang off the same repository object.
        assert.strictEqual(mockedExecute.mock.calls.length, 1);
        expect(callAt(0).args).toContain("number=7");
        expect(access).toEqual({ canWrite: false, canUpdate: true, didAuthor: true });
      }),
  );

  it.effect("reads the viewer's role off the same call as the merge settings", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              mergeCommitAllowed: false,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerPermission: "WRITE",
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const access = yield* cli.getRepositoryAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0).args).toContain(
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission",
      );
      assert.isTrue(access.canWrite);
      expect(access.mergeCapabilities).toEqual({ merge: false, squash: true, rebase: true });
    }),
  );

  it.effect("asks GitHub to review, naming the collection a request is added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [
          { id: "octocat", kind: "user" },
          { id: "reviewers", kind: "team" },
        ],
        requested: true,
      });

      const call = callAt(0);
      expect(call.args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/pulls/7/requested_reviewers",
        "--input",
        "-",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.stdin ?? "")).toEqual({
        reviewers: ["octocat"],
        team_reviewers: ["reviewers"],
      });
    }),
  );

  it.effect("takes a request back by deleting from the same collection it was added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: false,
      });

      const call = callAt(0);
      expect(call.args).toContain("DELETE");
      expect(call.args).toContain("repos/acme/web/pulls/7/requested_reviewers");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.stdin ?? "")).toEqual({
        reviewers: ["octocat"],
        team_reviewers: [],
      });
    }),
  );

  it.effect("reads who may review and who already has in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: {
                  assignableUsers: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ login: "bilal" }, { login: "octocat" }, { login: "hubot" }],
                  },
                  pullRequest: {
                    author: { login: "bilal" },
                    reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The people, who has been asked and who opened the pull request all hang off the same
      // repository object, so the menu costs one request.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0).args).toContain("number=7");
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
    }),
  );
});
