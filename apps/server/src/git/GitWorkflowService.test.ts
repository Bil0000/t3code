import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect.each(["checkout", "pull"])("keeps a %s behind a write in the same worktree", (action) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commandResolved = yield* Deferred.make<void>();
      const events: string[] = [];
      const observedAt = yield* DateTime.now;
      const driver = yield* VcsDriver.VcsDriver.pipe(
        Effect.provide(
          Layer.mock(VcsDriver.VcsDriver)({
            capabilities: {
              kind: "git",
              supportsWorktrees: true,
              supportsBookmarks: false,
              supportsAtomicSnapshot: false,
              supportsPushDefaultRemote: true,
              ignoreClassifier: "native",
            },
          }),
        ),
      );
      const workflow = yield* GitWorkflowService.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: ({ cwd }) =>
                Effect.gen(function* () {
                  if (cwd === "/repo/nested") yield* Deferred.succeed(commandResolved, undefined);
                  return {
                    kind: "git" as const,
                    driver,
                    repository: {
                      kind: "git" as const,
                      rootPath: cwd === "/other" ? "/other" : "/repo",
                      metadataPath: null,
                      freshness: {
                        source: "live-local" as const,
                        observedAt,
                        expiresAt: Option.none(),
                      },
                    },
                  };
                }),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              switchRef: ({ refName }) =>
                Effect.sync(() => {
                  events.push("checkout");
                  return { refName };
                }),
              pullCurrentBranch: () =>
                Effect.sync(() => {
                  events.push("pull");
                  return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
                }),
            }),
            Layer.mock(GitManager.GitManager)({}),
          ),
        ),
      );
      const write = yield* workflow
        .withWorktreeLock(
          "/repo",
          Effect.gen(function* () {
            events.push("validate");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            events.push("write");
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const command = yield* (
        action === "checkout"
          ? workflow.switchRef({ cwd: "/repo/nested", refName: "other" })
          : workflow.pullCurrentBranch("/repo/nested")
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(commandResolved);
      yield* workflow.withWorktreeLock(
        "/other",
        Effect.sync(() => events.push("other worktree")),
      );
      assert.deepStrictEqual(events, ["validate", "other worktree"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(write);
      yield* Fiber.join(command);
      assert.deepStrictEqual(events, ["validate", "other worktree", "write", action]);
    }).pipe(Effect.scoped),
  );

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
