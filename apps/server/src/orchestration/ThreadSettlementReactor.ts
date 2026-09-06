import { CommandId, getThreadPullRequestLinks } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { pullRequestMatchesProject } from "./ThreadPullRequestReactor.ts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    // A merge rechecks all candidates, including branches that discovery has
    // not linked yet. Those lookups can still have cached the PR as open.
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));

    // Return the thread when it still needs a pull request decision. A rejected
    // dispatch skips it for this snapshot instead of retrying through a lookup.
    const settleThread = Effect.fn("ThreadSettlementReactor.settleThread")(
      function* (
        thread: (typeof candidates)[number],
        summaries: ReadonlyArray<SettlementPullRequest>,
      ) {
        const settings = yield* settingsService.getSettings;
        const decisionNow = DateTime.formatIso(yield* DateTime.now);
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequests: summaries,
          now: decisionNow,
          autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
        });
        if (settledAt === null) {
          return thread;
        }
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotSequence: snapshot.snapshotSequence,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    // Inactivity needs no host state. Finish these decisions before any lookup
    // can fail or wait on the network, including lookups shared by recent threads.
    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) => settleThread(thread, []),
      {
        concurrency: 8,
      },
    )).filter((thread) => thread !== null);

    // Use the same cwd as PR discovery so both paths share GitManager's cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.branch === null) return;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          lookupCwdByThreadId.set(
            thread.id,
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // The merge confirmed a state the branch cache can still call open.
      // Recheck those branches now instead of waiting for cache expiry.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const referencesFor = (thread: (typeof candidates)[number]) => {
      const links = getThreadPullRequestLinks(thread);
      const linked = links.filter((link) => link.source === "linked");
      return linked.length > 0 ? linked : links;
    };
    const lookupKey = (thread: (typeof candidates)[number]) => {
      const references = referencesFor(thread);
      if (references.length > 0) {
        return JSON.stringify([
          "linked",
          references.map((reference) => [
            reference.projectId,
            reference.repository,
            reference.number,
          ]),
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(lookupCandidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      const references = referencesFor(thread);
      if (references.length > 0) {
        const summaries = yield* Effect.forEach(
          references,
          (reference) =>
            Effect.gen(function* () {
              const matchesMerge =
                mergedPullRequest !== null &&
                reference.projectId === mergedPullRequest.projectId &&
                reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
                reference.number === mergedPullRequest.number;
              if (!matchesMerge && !projects.has(reference.projectId)) {
                return yield* Effect.die(new Error("linked pull request project not found"));
              }
              const summary = matchesMerge
                ? ({
                    state: "merged",
                    closedAt: null,
                    mergedAt: mergedPullRequest.mergedAt,
                  } satisfies SettlementPullRequest)
                : yield* pullRequests.summary(
                    {
                      projectId: reference.projectId,
                      repository: reference.repository,
                      number: reference.number,
                    },
                    { recoverTransientFailure: false },
                  );
              return summary;
            }),
          { concurrency: 8 },
        );
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (
          summaries.every((summary) => summary.state !== "open") &&
          thread.branch !== null &&
          cwd !== undefined
        ) {
          // A reused branch can already have a new open PR while discovery
          // is replacing its old link. Do not let settlement win that race.
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          const project = projects.get(thread.projectId);
          if (
            current?.state === "open" &&
            project !== undefined &&
            pullRequestMatchesProject(current, project)
          ) {
            return [current];
          }
        }
        return summaries;
      }
      if (thread.branch === null) return [];
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      const current = yield* git.branchPullRequest({ cwd, branch: thread.branch });
      return current === null ? [] : [current];
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group[0]!);
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (mergedPullRequest: PullRequestService.PullRequestMergeEvent | null) =>
    sweep(mergedPullRequest).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep(null));

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, runSweep));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
