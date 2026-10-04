import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type IssueRef,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  ThreadIssueLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as IssueService from "../issue/IssueService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as IssueSyncReactor from "./IssueSyncReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const PROJECT_ID = ProjectId.make("issue-sync-project");
const issueLinksEqual = Schema.toEquivalence(ThreadIssueLink);
const LINK: ThreadIssueLink = {
  provider: "github",
  repository: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/issues/7",
  title: "Old title",
};
const THREAD: ProjectionStore.ProjectionThreadIssues = {
  id: ThreadId.make("issue-sync-thread"),
  projectId: PROJECT_ID,
  issues: [LINK],
};
type SyncCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.issue-link.sync" }>;

const metadataEvent = (
  thread: ProjectionStore.ProjectionThreadIssues,
  eventId: string,
): OrchestrationV2DomainEvent & { readonly type: "thread.metadata-updated" } => {
  const now = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");
  const instanceId = ProviderInstanceId.make("codex");
  return {
    id: EventId.make(eventId),
    type: "thread.metadata-updated",
    threadId: thread.id,
    occurredAt: now,
    payload: {
      ...thread,
      title: "Thread",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: thread.id, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};

const detail = (ref: IssueRef, changes: Partial<IssueDetail> = {}): IssueDetail => ({
  provider: ref.provider ?? "github",
  projectId: ref.projectId,
  projectTitle: "Project",
  workspaceRoot: "/workspace/project",
  repository: ref.repository,
  number: ref.number,
  title: "New title",
  url: `https://${ref.host ?? "github.com"}/${ref.repository}/issues/${ref.number}`,
  body: "",
  author: null,
  state: "closed",
  stateReason: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  linkedPullRequests: [],
  capabilities: {
    sorts: [],
    referenceStyle: "hash",
    closesViaPullRequest: true,
    comment: false,
    actions: [],
    closeReasons: [],
    create: false,
    issueTemplates: false,
    edit: false,
    labels: false,
    assignees: false,
    listLabelCandidates: false,
    listAssigneeCandidates: false,
    search: false,
    linkedPullRequests: false,
    timelineEvents: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    create: false,
  },
  ...changes,
});

const makeHarness = Effect.fn("makeIssueSyncHarness")(function* (
  threads: ReadonlyArray<ProjectionStore.ProjectionThreadIssues> = [THREAD],
  read: IssueService.IssueService["Service"]["detail"] = (ref) => Effect.succeed(detail(ref)),
) {
  const activation = yield* Deferred.make<void>();
  const currentThreads = yield* Ref.make(threads);
  const reads = yield* Ref.make<ReadonlyArray<IssueRef>>([]);
  const commands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const sweeps = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const processed = yield* Queue.unbounded<void>();
  const context = yield* Layer.build(
    IssueSyncReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadsWithIssues: (threadId) =>
              (threadId === undefined ? Queue.offer(sweeps, undefined) : Effect.void).pipe(
                Effect.andThen(Ref.get(currentThreads)),
                Effect.map((rows) =>
                  rows.filter((row) => threadId === undefined || row.id === threadId),
                ),
              ),
          }),
          Layer.mock(IssueService.IssueService)({
            invalidate: () => Effect.void,
            detail: (ref) =>
              Ref.update(reads, (rows) => [...rows, ref]).pipe(Effect.andThen(read(ref))),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events).pipe(
              Stream.rechunk(1),
              Stream.tap((event) =>
                event.type === "thread.visited" ? Queue.offer(processed, undefined) : Effect.void,
              ),
            ),
            dispatch: (command) => {
              if (command.type !== "thread.issue-link.sync")
                return Effect.die("Unexpected command");
              return Effect.gen(function* () {
                const current = (yield* Ref.get(currentThreads)).find(
                  (thread) =>
                    thread.id === command.threadId && thread.projectId === command.projectId,
                );
                if (
                  !(current?.issues ?? []).some((issue) =>
                    issueLinksEqual(issue, command.expectedIssue),
                  )
                ) {
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "The linked issue changed.",
                  });
                }
                yield* Ref.update(commands, (rows) => [...rows, command]);
                yield* Ref.update(currentThreads, (rows) =>
                  rows.map((thread) =>
                    thread.id === command.threadId
                      ? {
                          ...thread,
                          issues: (thread.issues ?? []).map((issue) =>
                            issue.number === command.issue.number ? command.issue : issue,
                          ),
                        }
                      : thread,
                  ),
                );
                const thread = (yield* Ref.get(currentThreads)).find(
                  (row) => row.id === command.threadId,
                )!;
                yield* Queue.offer(events, metadataEvent(thread, command.commandId));
                return { sequence: 1, storedEvents: [] };
              });
            },
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, bytes) => Effect.succeed(bytes),
            }),
          ),
        ),
      ),
    ),
  );
  const reactor = Context.get(context, IssueSyncReactor.IssueSyncReactor);
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(sweeps);
  const flushEvents = Effect.gen(function* () {
    const event = metadataEvent(THREAD, "barrier");
    yield* Queue.offer(events, { ...event, type: "thread.visited" });
    yield* Queue.take(processed);
    yield* reactor.drain;
  });
  return { reactor, currentThreads, reads, commands, sweeps, events, flushEvents };
});

it.effect("updates a legacy link's title and state and shares a read across threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHarness([THREAD, { ...THREAD, id: ThreadId.make("second") }]);
      yield* fixture.reactor.drain;
      assert.deepEqual(yield* Ref.get(fixture.reads), [
        {
          projectId: PROJECT_ID,
          provider: "github",
          repository: "owner/repo",
          number: 7,
          host: "github.com",
        },
      ]);
      const commands = yield* Ref.get(fixture.commands);
      assert.equal(commands.length, 2);
      assert.deepEqual(
        commands.map((command) => command.issue),
        [
          { ...LINK, title: "New title", state: "closed" },
          { ...LINK, title: "New title", state: "closed" },
        ],
      );
    }),
  ),
);

it.effect("ignores its own sync events and reads only actual additions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const links = [7, 8, 9].map((number) => ({
        ...LINK,
        number,
        url: `https://github.com/owner/repo/issues/${number}`,
      }));
      let state: "open" | "closed" = "open";
      const fixture = yield* makeHarness([{ ...THREAD, issues: links }], (ref) =>
        Effect.succeed(detail(ref, { state })),
      );
      yield* fixture.reactor.drain;
      yield* fixture.flushEvents;
      assert.equal((yield* Ref.get(fixture.reads)).length, 3);
      assert.equal((yield* Ref.get(fixture.commands)).length, 3);
      const current = (yield* Ref.get(fixture.currentThreads))[0]!;
      const next = {
        ...current,
        issues: [
          ...(current.issues ?? []),
          {
            ...LINK,
            number: 10,
            url: "https://github.com/owner/repo/issues/10",
            linkId: CommandId.make("user:link:10"),
          },
        ],
      };
      state = "closed";
      yield* Ref.set(fixture.currentThreads, [next]);
      yield* Queue.offer(fixture.events, metadataEvent(next, "user:link:10"));
      yield* fixture.flushEvents;
      yield* fixture.flushEvents;
      assert.deepEqual(
        (yield* Ref.get(fixture.reads)).map((ref) => ref.number),
        [7, 8, 9, 10],
      );
      assert.equal((yield* Ref.get(fixture.commands)).length, 4);
      const synced = (yield* Ref.get(fixture.currentThreads))[0]!;
      const relinked = {
        ...synced,
        issues: (synced.issues ?? []).map((issue) =>
          issue.number === 10 ? { ...issue, linkId: CommandId.make("user:relink:10") } : issue,
        ),
      };
      yield* Ref.set(fixture.currentThreads, [relinked]);
      yield* Queue.offer(fixture.events, metadataEvent(relinked, "user:relink:10"));
      yield* fixture.flushEvents;
      assert.deepEqual(
        (yield* Ref.get(fixture.reads)).map((ref) => ref.number),
        [7, 8, 9, 10, 10],
      );
    }),
  ),
);

it.effect("leaves an unchanged link alone and notices reopening on the slower closed cadence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let state: "open" | "closed" = "closed";
      const fixture = yield* makeHarness(
        [{ ...THREAD, issues: [{ ...LINK, state: "closed" }] }],
        (ref) => Effect.succeed(detail(ref, { title: LINK.title, state })),
      );
      yield* fixture.reactor.drain;
      assert.deepEqual(yield* Ref.get(fixture.commands), []);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(fixture.sweeps);
      yield* fixture.reactor.drain;
      assert.equal((yield* Ref.get(fixture.reads)).length, 1);
      state = "open";
      for (let minute = 0; minute < 14; minute++) {
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.sweeps);
        yield* fixture.reactor.drain;
      }
      assert.equal((yield* Ref.get(fixture.reads)).length, 2);
      assert.equal((yield* Ref.get(fixture.commands))[0]?.issue.state, "open");
    }),
  ),
);

it.effect("keeps project, provider, and host routes separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHarness([
        THREAD,
        { ...THREAD, id: ThreadId.make("other-project"), projectId: ProjectId.make("other") },
        {
          ...THREAD,
          id: ThreadId.make("other-provider"),
          issues: [{ ...LINK, provider: "custom" }],
        },
        {
          ...THREAD,
          id: ThreadId.make("other-host"),
          issues: [{ ...LINK, url: "https://enterprise.example/owner/repo/issues/7" }],
        },
      ]);
      yield* fixture.reactor.drain;
      assert.equal((yield* Ref.get(fixture.reads)).length, 4);
      assert.equal((yield* Ref.get(fixture.commands)).length, 4);
    }),
  ),
);

it.effect("does not replace a link with a result from another host or issue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cases: ReadonlyArray<Partial<IssueDetail>> = [
        { url: "https://enterprise.example/owner/repo/issues/7" },
        { projectId: ProjectId.make("other-project") },
        { provider: "gitlab" },
        { repository: "owner/other-repo" },
        { number: 8 },
      ];
      for (const changes of cases) {
        const fixture = yield* makeHarness([THREAD], (ref) => Effect.succeed(detail(ref, changes)));
        yield* fixture.reactor.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
      }
    }),
  ),
);

it.effect("does not write after unlink while a host read is in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hostRead = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const fixture = yield* makeHarness([THREAD], (ref) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(hostRead)),
          Effect.as(detail(ref)),
        ),
      );
      yield* Deferred.await(entered);
      yield* Ref.set(fixture.currentThreads, []);
      yield* Deferred.succeed(hostRead, undefined);
      yield* fixture.reactor.drain;
      assert.deepEqual(yield* Ref.get(fixture.commands), []);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(fixture.sweeps);
      yield* fixture.reactor.drain;
      assert.equal((yield* Ref.get(fixture.reads)).length, 1);
    }),
  ),
);

it.effect("does not write a host result after relink or a newer title or state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const original = { ...LINK, linkId: CommandId.make("original") };
      const replacements: ReadonlyArray<ThreadIssueLink> = [
        { ...original, linkId: CommandId.make("relinked") },
        { ...original, title: "Newer title" },
        { ...original, state: "open" },
      ];
      for (const replacement of replacements) {
        const entered = yield* Deferred.make<void>();
        const returned = yield* Deferred.make<void>();
        const fixture = yield* makeHarness([{ ...THREAD, issues: [original] }], (ref) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(returned)),
            Effect.as(detail(ref)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Ref.set(fixture.currentThreads, [{ ...THREAD, issues: [replacement] }]);
        yield* Deferred.succeed(returned, undefined);
        yield* fixture.reactor.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        assert.deepEqual((yield* Ref.get(fixture.currentThreads))[0]?.issues, [replacement]);
      }
    }),
  ),
);

it.effect("keeps syncing shared links when one thread unlinks during the read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const remaining = { ...THREAD, id: ThreadId.make("remaining") };
      const entered = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const fixture = yield* makeHarness([THREAD, remaining], (ref) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(returned)),
          Effect.as(detail(ref)),
        ),
      );
      yield* Deferred.await(entered);
      yield* Ref.set(fixture.currentThreads, [remaining]);
      yield* Deferred.succeed(returned, undefined);
      yield* fixture.reactor.drain;
      assert.deepEqual(
        (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
        [remaining.id],
      );
    }),
  ),
);

it.effect("cancels an in-flight read when the reactor scope closes", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const fixture = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness([THREAD], () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        );
        yield* Deferred.await(entered);
        return fixture;
      }),
    );
    yield* Deferred.await(interrupted);
    assert.deepEqual(yield* Ref.get(fixture.commands), []);
  }),
);
