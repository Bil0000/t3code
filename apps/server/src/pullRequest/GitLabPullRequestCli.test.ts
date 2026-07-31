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
  return callAt(index).args;
}

/** The whole nth invocation, so a request body can be asserted alongside its path. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
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

  it.effect("asks GitLab for every state on the All tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("state=all");
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

  it.effect("returns what it read when the diff response was cut off mid-JSON", () =>
    Effect.gen(function* () {
      const fullPage = (start: number) =>
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            old_path: `src/${start + index}.ts`,
            new_path: `src/${start + index}.ts`,
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          })),
        );
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(fullPage(0))))
        // A byte-truncated prefix: valid JSON never survives the cut.
        .mockReturnValueOnce(
          Effect.succeed({ ...output('[{"old_path":"src/x.ts","new_p'), stdoutTruncated: true }),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.isTrue(diff.truncated);
      // The first page survives rather than the whole read failing.
      expect(diff.patch).toContain("diff --git a/src/0.ts b/src/0.ts");
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

  it.effect("reads a positioned discussion as a thread anchored to its line", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output(
            JSON.stringify([
              {
                id: "abc123",
                notes: [
                  {
                    id: 1,
                    body: "rename this",
                    author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                    created_at: "2026-07-01T00:00:00Z",
                    resolvable: true,
                    resolved: true,
                    position: {
                      position_type: "text",
                      new_path: "src/a.ts",
                      old_path: "src/a.ts",
                      new_line: 12,
                      old_line: null,
                    },
                  },
                  {
                    id: 2,
                    body: "done",
                    author: { username: "julius" },
                    created_at: "2026-07-01T01:00:00Z",
                  },
                ],
              },
              // A plain note is the timeline's business, not the diff's.
              { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
            ]),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { threads } = yield* cli.listDiscussions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "abc123",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: true,
      });
      assert.strictEqual(threads[0]?.comments.length, 2);
    }),
  );

  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", line: 4, side: "left", body: "why remove?" }],
      });

      // The diff revisions first, because a positioned comment cannot be placed without them.
      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "src/a.ts",
          new_path: "src/a.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      // The verdict goes last, so a review that failed part-way is never an approval.
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );

  it.effect("does not ask for diff revisions when a review carries no line comments", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "comment",
        body: "One thought.",
        comments: [],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(argsOfCall(0)[1]).toContain("/notes");
    }),
  );

  it.effect("resolves a discussion in place rather than posting to it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setDiscussionResolution({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        discussionId: "abc123",
        resolved: true,
      });

      expect(argsOfCall(0)).toContain("--method");
      expect(argsOfCall(0)).toContain("PUT");
      expect(argsOfCall(0)[1]).toContain("/discussions/abc123");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ resolved: true });
    }),
  );
});
