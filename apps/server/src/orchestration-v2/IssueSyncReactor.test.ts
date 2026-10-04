import {
  IssueOperationError,
  IssueUnavailableError,
  ProjectId,
  ThreadId,
  type IssueDetail,
  type OrchestrationV2ServerCommand,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as IssueService from "../issue/IssueService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as IssueSyncReactor from "./IssueSyncReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

type SyncCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.issue-link.sync" }
>;

const PROJECT_ID = ProjectId.make("project-1");

const link: ThreadIssueLink = {
  provider: "github",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "Old title",
};

const detail = {
  provider: "github",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "Crash on start",
  state: "open",
  stateReason: null,
} as IssueDetail;

const otherLink: ThreadIssueLink = {
  ...link,
  number: 8,
  url: "https://github.com/acme/app/issues/8",
};

const makeHarness = Effect.fn("makeIssueSyncHarness")(function* (
  detail: IssueService.IssueService["Service"]["detail"],
  options: {
    readonly settledAt?: DateTime.Utc;
    readonly links?: ReadonlyArray<ThreadIssueLink>;
    /** The second thread's project; the first is always PROJECT_ID. */
    readonly otherProjectId?: ProjectId;
  } = {},
) {
  const activation = yield* Deferred.make<void>();
  const reads = yield* Queue.unbounded<void>();
  const issueReads = yield* Ref.make(0);
  const commands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const threads = yield* Ref.make<ReadonlyArray<ProjectionStore.ProjectionThreadIssues>>(
    ["thread-a", "thread-b"].map((id, index) => ({
      id: ThreadId.make(id),
      projectId: index === 0 ? PROJECT_ID : (options.otherProjectId ?? PROJECT_ID),
      settledOverride: null,
      settledAt: options.settledAt ?? null,
      issues: options.links ?? [link],
    })),
  );

  const dependencies = Layer.mergeAll(
    Layer.mock(IssueService.IssueService)({
      detail: (ref) =>
        Ref.update(issueReads, (count) => count + 1).pipe(Effect.andThen(detail(ref))),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithIssues: () =>
        Queue.offer(reads, undefined).pipe(Effect.andThen(Ref.get(threads))),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        command.type === "thread.issue-link.sync"
          ? Effect.gen(function* () {
              yield* Ref.update(commands, (recorded) => [...recorded, command]);
              // What the orchestrator would persist, so the next sweep sees its own writes.
              yield* Ref.update(threads, (current) =>
                current.map((thread) =>
                  thread.id !== command.threadId
                    ? thread
                    : {
                        ...thread,
                        issues: (thread.issues ?? []).map((existing) =>
                          existing.url === command.url
                            ? {
                                ...existing,
                                title: command.title,
                                state: command.state,
                                stateReason: command.stateReason,
                              }
                            : existing,
                        ),
                      },
                ),
              );
              return { sequence: 1, storedEvents: [] };
            })
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

  const start = Effect.gen(function* () {
    const reactor = yield* IssueSyncReactor.IssueSyncReactor;
    yield* reactor.start();
    yield* Deferred.succeed(activation, undefined);
    yield* Queue.take(reads);
    yield* reactor.drain;
    return reactor;
  });
  const sweepAfter = (reactor: IssueSyncReactor.IssueSyncReactor["Service"], minutes: number) =>
    Effect.gen(function* () {
      for (let minute = 0; minute < minutes; minute++) {
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(reads);
        yield* reactor.drain;
      }
    });

  return {
    reads,
    issueReads,
    commands,
    start,
    sweepAfter,
    layer: IssueSyncReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

describe("IssueSyncReactor", () => {
  it.effect("reads a shared issue once and writes only what changed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(detail));
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        const synced = yield* Ref.get(harness.commands);
        assert.deepEqual(
          synced.map((command) => [command.threadId, command.title]),
          [
            ["thread-a", "Crash on start"],
            ["thread-b", "Crash on start"],
          ],
        );

        // An open issue is read every four to five minutes, and an unchanged one writes nothing.
        yield* harness.sweepAfter(reactor, 3);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 2);
        assert.equal(yield* Ref.get(harness.issueReads), 2);
        assert.equal((yield* Ref.get(harness.commands)).length, 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("polls open issues slowly once every thread linking them has settled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(detail), {
        settledAt: DateTime.makeUnsafe("2026-09-03T00:00:00.000Z"),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        yield* harness.sweepAfter(reactor, 23);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 7);
        assert.equal(yield* Ref.get(harness.issueReads), 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("backs off from an issue the tracker refuses", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() =>
        Effect.fail(new IssueOperationError({ operation: "detail", detail: "gone" })),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        yield* harness.sweepAfter(reactor, 29);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 1);
        assert.equal(yield* Ref.get(harness.issueReads), 2);
        assert.deepEqual(yield* Ref.get(harness.commands), []);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("retries a tracker that is unavailable after a few minutes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() =>
        Effect.fail(
          new IssueUnavailableError({ reason: "cli-unauthenticated", provider: "github" }),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        yield* harness.sweepAfter(reactor, 4);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 1);
        assert.equal(yield* Ref.get(harness.issueReads), 2);
        assert.deepEqual(yield* Ref.get(harness.commands), []);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("asks a signed-out tracker once per retry, however many issues it holds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        () =>
          Effect.fail(
            new IssueUnavailableError({ reason: "cli-unauthenticated", provider: "github" }),
          ),
        { links: [link, otherLink] },
      );
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 4);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        yield* harness.sweepAfter(reactor, 1);
        assert.equal(yield* Ref.get(harness.issueReads), 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves links that carry a state until they come due", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(detail), {
        links: [{ ...link, state: "open", stateReason: null }],
      });
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        assert.equal(yield* Ref.get(harness.issueReads), 0);
        yield* harness.sweepAfter(reactor, 5);
        assert.equal(yield* Ref.get(harness.issueReads), 1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reads an issue at once when asked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(detail), {
        links: [{ ...link, state: "open", stateReason: null }],
      });
      yield* Effect.gen(function* () {
        const reactor = yield* harness.start;
        yield* reactor.requestSync({ repository: "ACME/app", number: 7 });
        yield* Queue.take(harness.reads);
        yield* reactor.drain;
        assert.equal(yield* Ref.get(harness.issueReads), 1);
        assert.deepEqual(
          (yield* Ref.get(harness.commands)).map((command) => command.title),
          ["Crash on start", "Crash on start"],
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reads through another linking project when the first cannot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        (ref) =>
          ref.projectId === PROJECT_ID
            ? Effect.fail(new IssueOperationError({ operation: "detail", detail: "no remote" }))
            : Effect.succeed(detail),
        { otherProjectId: ProjectId.make("project-2") },
      );
      yield* Effect.gen(function* () {
        yield* harness.start;
        assert.equal(yield* Ref.get(harness.issueReads), 2);
        assert.equal((yield* Ref.get(harness.commands)).length, 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
