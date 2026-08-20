import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const testCommitHash = "0123456789abcdef0123456789abcdef01234567";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.git ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns non-repository History results when no VCS repository is detected", () => {
    const detect = vi.fn(() => Effect.succeed(null));
    const listHistoryRefs = vi.fn(() =>
      Effect.succeed({
        refs: [],
        currentRef: null,
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        isComplete: true,
      }),
    );
    const getHistory = vi.fn(() =>
      Effect.succeed({
        commits: [],
        isRepo: false,
        nextCursor: null,
        hasMore: false,
        capped: false,
      }),
    );
    const getCommitDetails = vi.fn(() => Effect.succeed({ commit: null, isRepo: false }));
    const listCommitFiles = vi.fn(() =>
      Effect.succeed({ files: [], isRepo: false, nextCursor: null, hasMore: false, capped: false }),
    );
    const getCommitDiff = vi.fn(() =>
      Effect.succeed({ diff: "", truncated: false, isRepo: false }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listHistoryRefs({ cwd: "/not-a-repo" });
      const history = yield* workflow.getHistory({ cwd: "/not-a-repo" });
      const details = yield* workflow.getCommitDetails({
        cwd: "/not-a-repo",
        hash: testCommitHash,
      });
      const files = yield* workflow.listCommitFiles({
        cwd: "/not-a-repo",
        hash: testCommitHash,
      });
      const diff = yield* workflow.getCommitDiff({
        cwd: "/not-a-repo",
        hash: testCommitHash,
      });

      assert.deepStrictEqual(refs, {
        refs: [],
        currentRef: null,
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        isComplete: true,
      });
      assert.deepStrictEqual(history, {
        commits: [],
        isRepo: false,
        nextCursor: null,
        hasMore: false,
        capped: false,
      });
      assert.deepStrictEqual(details, { commit: null, isRepo: false });
      assert.deepStrictEqual(files, {
        files: [],
        isRepo: false,
        nextCursor: null,
        hasMore: false,
        capped: false,
      });
      assert.deepStrictEqual(diff, { diff: "", truncated: false, isRepo: false });
      assert.equal(detect.mock.calls.length, 5);
      assert.equal(listHistoryRefs.mock.calls.length, 0);
      assert.equal(getHistory.mock.calls.length, 0);
      assert.equal(getCommitDetails.mock.calls.length, 0);
      assert.equal(listCommitFiles.mock.calls.length, 0);
      assert.equal(getCommitDiff.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect,
          git: { listHistoryRefs, getHistory, getCommitDetails, listCommitFiles, getCommitDiff },
        }),
      ),
    );
  });

  it.effect("delegates each History operation to GitVcsDriver once for Git repositories", () => {
    const detect = vi.fn(() =>
      Effect.succeed({
        kind: "git" as const,
        repository: {
          kind: "git" as const,
          rootPath: "/repo",
          metadataPath: null,
          freshness: {
            source: "live-local" as const,
            observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
            expiresAt: Option.none(),
          },
        },
        driver: {} as never,
      } satisfies VcsDriverRegistry.VcsDriverHandle),
    );
    const listHistoryRefs = vi.fn(() => Effect.die("unused"));
    const getHistory = vi.fn(() => Effect.die("unused"));
    const getCommitDetails = vi.fn(() => Effect.die("unused"));
    const listCommitFiles = vi.fn(() => Effect.die("unused"));
    const getCommitDiff = vi.fn(() => Effect.die("unused"));

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const historyInput = { cwd: "/repo" };
      const commitInput = {
        cwd: "/repo",
        hash: testCommitHash,
      };

      yield* workflow.listHistoryRefs(historyInput).pipe(Effect.exit);
      yield* workflow.getHistory(historyInput).pipe(Effect.exit);
      yield* workflow.getCommitDetails(commitInput).pipe(Effect.exit);
      yield* workflow.listCommitFiles(commitInput).pipe(Effect.exit);
      yield* workflow.getCommitDiff(commitInput).pipe(Effect.exit);

      assert.deepStrictEqual(listHistoryRefs.mock.calls, [[historyInput]]);
      assert.deepStrictEqual(getHistory.mock.calls, [[historyInput]]);
      assert.deepStrictEqual(getCommitDetails.mock.calls, [[commitInput]]);
      assert.deepStrictEqual(listCommitFiles.mock.calls, [[commitInput]]);
      assert.deepStrictEqual(getCommitDiff.mock.calls, [[commitInput]]);
      assert.equal(detect.mock.calls.length, 5);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect,
          git: { listHistoryRefs, getHistory, getCommitDetails, listCommitFiles, getCommitDiff },
        }),
      ),
    );
  });

  it.effect(
    "returns non-repository History results for an explicitly configured jj repository",
    () => {
      const detect = vi.fn(() =>
        Effect.succeed({
          kind: "jj" as const,
          repository: {
            kind: "jj" as const,
            rootPath: "/jj-repo",
            metadataPath: "/jj-repo/.jj",
            freshness: {
              source: "live-local" as const,
              observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
              expiresAt: Option.none(),
            },
          },
          driver: {} as never,
        } satisfies VcsDriverRegistry.VcsDriverHandle),
      );
      const listHistoryRefs = vi.fn(() => Effect.die("must not call GitVcsDriver"));
      const getHistory = vi.fn(() => Effect.die("must not call GitVcsDriver"));
      const getCommitDetails = vi.fn(() => Effect.die("must not call GitVcsDriver"));
      const listCommitFiles = vi.fn(() => Effect.die("must not call GitVcsDriver"));
      const getCommitDiff = vi.fn(() => Effect.die("must not call GitVcsDriver"));

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const historyInput = { cwd: "/jj-repo" };
        const commitInput = { cwd: "/jj-repo", hash: testCommitHash };

        assert.deepStrictEqual(yield* workflow.listHistoryRefs(historyInput), {
          refs: [],
          currentRef: null,
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          isComplete: true,
        });
        assert.deepStrictEqual(yield* workflow.getHistory(historyInput), {
          commits: [],
          isRepo: false,
          nextCursor: null,
          hasMore: false,
          capped: false,
        });
        assert.deepStrictEqual(yield* workflow.getCommitDetails(commitInput), {
          commit: null,
          isRepo: false,
        });
        assert.deepStrictEqual(yield* workflow.listCommitFiles(commitInput), {
          files: [],
          isRepo: false,
          nextCursor: null,
          hasMore: false,
          capped: false,
        });
        assert.deepStrictEqual(yield* workflow.getCommitDiff(commitInput), {
          diff: "",
          truncated: false,
          isRepo: false,
        });

        assert.equal(detect.mock.calls.length, 5);
        assert.equal(listHistoryRefs.mock.calls.length, 0);
        assert.equal(getHistory.mock.calls.length, 0);
        assert.equal(getCommitDetails.mock.calls.length, 0);
        assert.equal(listCommitFiles.mock.calls.length, 0);
        assert.equal(getCommitDiff.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect,
            git: { listHistoryRefs, getHistory, getCommitDetails, listCommitFiles, getCommitDiff },
          }),
        ),
      );
    },
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
