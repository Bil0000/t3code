import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskError, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import type { RelayScheduledTaskState } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ScheduledTaskCoordinator } from "./ScheduledTaskCoordinator.ts";
import * as ScheduledTasks from "./ScheduledTaskService.ts";

const input = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
  commandId: "replica",
  title: "Review",
  prompt: "Review changes",
  enabled: false,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project:replica",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  failover: {
    groupId: "e6d5501c-e8e8-4a76-b06d-776d170ac39a",
    revision: "0e2a7a35-2e09-4b87-808b-1604601e6cf2",
    environmentIds: ["primary", "backup"],
    timeZone: "Europe/Berlin",
  },
});
const failover = input.failover!;
const initial: RelayScheduledTaskState = {
  ...failover,
  enabled: false,
  schedule: input.schedule,
  nextRunAt: "2040-09-17T10:00:00.000Z",
};
const unreachable = new ScheduledTaskError({ message: "Coordinator unreachable" });

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  SqlitePersistenceMemory,
  Layer.mock(ThreadManagementService)({}),
);

it.effect(
  "validates disabled shared configuration before writing a replica and fences removal",
  () => {
    let state = initial;
    let reachable = true;
    const coordinator = Layer.mock(ScheduledTaskCoordinator)({
      available: Effect.succeed(true),
      get: () =>
        Effect.suspend(() => (reachable ? Effect.succeed(state) : Effect.fail(unreachable))),
      delete: () => Effect.suspend(() => (reachable ? Effect.void : Effect.fail(unreachable))),
      setEnabled: (_, enabled) => Effect.sync(() => (state = { ...state, enabled })),
    });
    return Effect.gen(function* () {
      const service = yield* ScheduledTasks.ScheduledTaskService;
      state = { ...initial, enabled: true };
      expect((yield* Effect.result(service.upsert(input)))._tag).toBe("Failure");
      expect((yield* service.list()).tasks).toHaveLength(0);
      state = { ...initial, timeZone: "UTC" };
      expect((yield* Effect.result(service.upsert(input)))._tag).toBe("Failure");
      state = initial;
      const task = (yield* service.upsert(input)).task;
      expect(task.nextRunAt).toBe(initial.nextRunAt);
      expect(task.enabled).toBe(false);
      const enabled = yield* service.setEnabled({ id: task.id, enabled: true });
      expect(enabled.task.enabled).toBe(true);
      expect(state.enabled).toBe(true);
      yield* service.setEnabled({ id: task.id, enabled: false });
      expect(state.enabled).toBe(false);
      reachable = false;
      expect(
        (yield* Effect.result(service.upsert({ ...input, id: task.id, failover: null })))._tag,
      ).toBe("Failure");
      expect((yield* service.list()).tasks[0]?.failover).toEqual(failover);
      expect((yield* Effect.result(service.runNow({ id: task.id })))._tag).toBe("Failure");
      reachable = true;
      yield* service.delete({ id: task.id });
      expect((yield* service.list()).tasks).toHaveLength(0);
    }).pipe(
      Effect.provide(
        ScheduledTasks.layer.pipe(
          Layer.provide(
            Layer.mergeAll(dependencies, coordinator, Layer.mock(ThreadLaunchService)({})),
          ),
        ),
      ),
    );
  },
);

it.effect("launches only a claimed occurrence, uses relay time, and never replays it", () =>
  Effect.gen(function* () {
    const secondPoll = yield* Deferred.make<void>();
    const refusedPoll = yield* Deferred.make<void>();
    let polls = 0;
    let launches = 0;
    let commandId = "";
    let reachable = true;
    const coordinator = Layer.mock(ScheduledTaskCoordinator)({
      available: Effect.succeed(true),
      get: () => Effect.succeed(initial),
      claim: () =>
        Effect.gen(function* () {
          if (!reachable) {
            yield* Deferred.succeed(refusedPoll, undefined);
            return yield* unreachable;
          }
          polls += 1;
          if (polls === 2) yield* Deferred.succeed(secondPoll, undefined);
          return {
            ...initial,
            enabled: true,
            occurrenceId: polls === 1 ? "shared-occurrence-1" : null,
          };
        }),
    });
    const launch = Layer.mock(ThreadLaunchService)({
      launch: (request) =>
        Effect.sync(() => {
          launches += 1;
          commandId = request.commandId;
        }).pipe(Effect.andThen(Effect.die("Synthetic dispatch failure"))),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTasks.ScheduledTaskService;
      const task = (yield* service.upsert(input)).task;
      const completed = yield* service.subscribeList().pipe(
        Stream.filter((list) =>
          list.tasks.some((entry) => entry.id === task.id && entry.runCount === 1),
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(completed);
      expect(launches).toBe(1);
      expect(commandId).toBe("scheduled-task:shared-occurrence-1");
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(initial.nextRunAt);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(secondPoll);
      expect(launches).toBe(1);
      reachable = false;
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(refusedPoll);
      expect(launches).toBe(1);
    }).pipe(
      Effect.provide(
        ScheduledTasks.layer.pipe(Layer.provide(Layer.mergeAll(dependencies, coordinator, launch))),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("does not dispatch a claim after the local replica is edited", () =>
  Effect.gen(function* () {
    const nextPoll = yield* Deferred.make<void>();
    let state = initial;
    let polls = 0;
    let service: ScheduledTasks.ScheduledTaskService["Service"];
    const coordinator = Layer.mock(ScheduledTaskCoordinator)({
      available: Effect.succeed(true),
      get: () => Effect.sync(() => state),
      claim: () =>
        Effect.gen(function* () {
          polls += 1;
          if (polls === 1) {
            state = { ...initial, revision: "72eadc4d-d1e6-4c06-901f-7e4dc2a98bd4" };
            yield* service.upsert({
              ...input,
              failover: { ...failover, revision: state.revision },
            });
            return { ...initial, enabled: true, occurrenceId: "old-revision-occurrence" };
          }
          yield* Deferred.succeed(nextPoll, undefined);
          return { ...state, occurrenceId: null };
        }),
    });
    yield* Effect.gen(function* () {
      service = yield* ScheduledTasks.ScheduledTaskService;
      yield* service.upsert(input);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(nextPoll);
      const task = (yield* service.list()).tasks[0];
      expect(task?.runCount).toBe(0);
      expect(task?.failover?.revision).toBe(state.revision);
      expect(task?.enabled).toBe(false);
    }).pipe(
      Effect.provide(
        ScheduledTasks.layer.pipe(
          Layer.provide(
            Layer.mergeAll(dependencies, coordinator, Layer.mock(ThreadLaunchService)({})),
          ),
        ),
      ),
    );
  }),
);

it.effect("keeps ordinary schedules running while relay coordination is stalled", () =>
  Effect.gen(function* () {
    const launched = yield* Deferred.make<void>();
    const coordinator = Layer.mock(ScheduledTaskCoordinator)({
      available: Effect.succeed(true),
      get: () => Effect.succeed(initial),
      claim: () => Effect.never,
    });
    const launch = Layer.mock(ThreadLaunchService)({
      launch: () =>
        Deferred.succeed(launched, undefined).pipe(
          Effect.andThen(Effect.die("Synthetic dispatch failure")),
        ),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTasks.ScheduledTaskService;
      yield* service.upsert(input);
      yield* service.upsert({ ...input, commandId: undefined, enabled: true, failover: null });
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(launched);
    }).pipe(
      Effect.provide(
        ScheduledTasks.layer.pipe(Layer.provide(Layer.mergeAll(dependencies, coordinator, launch))),
      ),
    );
  }),
);
