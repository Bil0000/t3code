import { CommandId, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";

interface TemporaryThreadClientIdentity {
  readonly sessionId: string;
  readonly clientId: string;
}

interface TemporaryThreadViews {
  readonly viewId: string;
  readonly generation: number;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly background: boolean;
}

export class TemporaryThreadServiceError extends Schema.TaggedError<TemporaryThreadServiceError>()(
  "TemporaryThreadServiceError",
  {
    operation: Schema.Literals(["views", "keep", "discard"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Temporary thread operation ${this.operation} failed.`;
  }
}

export class TemporaryThreadLifecycleState extends Context.Service<
  TemporaryThreadLifecycleState,
  {
    readonly discarding: Set<ThreadId>;
    readonly commands: KeyedLock.KeyedLock<ThreadId>;
    readonly preparations: Map<ThreadId, Set<Fiber.Fiber<void>>>;
  }
>()("t3/orchestration-v2/TemporaryThreadService/TemporaryThreadLifecycleState") {}

export const layerState = Layer.effect(
  TemporaryThreadLifecycleState,
  Effect.gen(function* () {
    return {
      discarding: new Set<ThreadId>(),
      commands: yield* KeyedLock.make<ThreadId>(),
      preparations: new Map<ThreadId, Set<Fiber.Fiber<void>>>(),
    };
  }),
);

export class TemporaryThreadCleanup extends Context.Service<
  TemporaryThreadCleanup,
  {
    readonly stopAndTeardown: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
  }
>()("t3/orchestration-v2/TemporaryThreadService/TemporaryThreadCleanup") {}

export class TemporaryThreadService extends Context.Service<
  TemporaryThreadService,
  {
    readonly updateViews: (
      identity: TemporaryThreadClientIdentity,
      input: TemporaryThreadViews,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
    readonly disconnectClient: (
      identity: TemporaryThreadClientIdentity,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
    readonly keep: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, TemporaryThreadServiceError>;
    readonly discard: (threadId: ThreadId) => Effect.Effect<void, TemporaryThreadServiceError>;
  }
>()("t3/orchestration-v2/TemporaryThreadService") {}

interface View {
  readonly identity: TemporaryThreadClientIdentity;
  readonly generation: number;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly background: boolean;
  readonly disconnected: boolean;
  readonly expiry: Fiber.Fiber<void, TemporaryThreadServiceError> | undefined;
}

const make = Effect.gen(function* () {
  const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
  const state = yield* TemporaryThreadLifecycleState;
  const cleanup = yield* TemporaryThreadCleanup;
  const scope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const views = new Map<string, View>();
  const unowned = new Map<ThreadId, Fiber.Fiber<void, TemporaryThreadServiceError>>();
  const pendingDiscards = new Set<ThreadId>();
  const sameIdentity = (
    left: TemporaryThreadClientIdentity,
    right: TemporaryThreadClientIdentity,
  ) => left.sessionId === right.sessionId && left.clientId === right.clientId;
  const mapError =
    (operation: TemporaryThreadServiceError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new TemporaryThreadServiceError({
        operation,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const hasView = (family: ReadonlyArray<ThreadId>) =>
    [...views.values()].some((view) => view.threadIds.some((id) => family.includes(id)));

  const discardUnlocked = Effect.fn("TemporaryThreadService.discardUnlocked")(function* (
    threadId: ThreadId,
  ) {
    if (!(yield* storage.isTemporary(threadId))) {
      pendingDiscards.delete(threadId);
      return;
    }
    pendingDiscards.add(threadId);
    const before = yield* storage.family(threadId);
    const family = yield* state.commands.withLock(
      before[0] ?? threadId,
      Effect.gen(function* () {
        const current = yield* storage.family(threadId);
        for (const id of current) state.discarding.add(id);
        yield* storage
          .markDiscarding(threadId)
          .pipe(Effect.mapError(mapError("discard", threadId)));
        return current;
      }),
    );
    yield* cleanup.stopAndTeardown(family);
    yield* storage.discard(threadId).pipe(Effect.mapError(mapError("discard", threadId)));
    for (const [viewId, view] of views) {
      views.set(viewId, {
        ...view,
        threadIds: view.threadIds.filter((id) => !family.includes(id)),
      });
    }
    for (const id of family) {
      pendingDiscards.delete(id);
      const timer = unowned.get(id);
      unowned.delete(id);
      if (timer !== undefined) yield* Fiber.interrupt(timer);
    }
  }, Effect.uninterruptible);

  const discardUnviewed = Effect.fn("TemporaryThreadService.discardUnviewed")(function* (
    ids: ReadonlyArray<ThreadId>,
  ) {
    for (const id of ids) {
      if (!(yield* storage.isTemporary(id))) continue;
      const family = yield* storage.family(id);
      if (!hasView(family)) pendingDiscards.add(id);
    }
    for (const id of pendingDiscards) yield* discardUnlocked(id);
  });

  const updateViews = Effect.fn("TemporaryThreadService.updateViews")(
    function* (identity: TemporaryThreadClientIdentity, input: TemporaryThreadViews) {
      const previous = views.get(input.viewId);
      if (previous !== undefined && previous.identity.sessionId !== identity.sessionId) {
        return yield* new TemporaryThreadServiceError({
          operation: "views",
          cause: "View belongs to another client.",
        });
      }
      yield* discardUnviewed([]);
      if (previous !== undefined && input.generation <= previous.generation) return;
      const threadIds: Array<ThreadId> = [];
      for (const id of new Set(input.threadIds)) {
        if ((yield* storage.isDiscarded(id)) || state.discarding.has(id)) continue;
        const registered = yield* Effect.result(storage.register({ threadId: id }));
        if (registered._tag === "Failure") {
          if (registered.failure.operation === "already-durable") continue;
          return yield* mapError("views", id)(registered.failure);
        }
        if (yield* storage.isTemporary(id)) threadIds.push(id);
      }
      views.set(input.viewId, {
        identity,
        generation: input.generation,
        threadIds,
        background: input.background,
        disconnected: false,
        expiry: undefined,
      });
      if (previous?.expiry !== undefined) yield* Fiber.interrupt(previous.expiry);
      for (const id of threadIds) {
        const family = yield* storage.family(id);
        for (const member of family) {
          const timer = unowned.get(member);
          unowned.delete(member);
          if (timer !== undefined) yield* Fiber.interrupt(timer);
        }
      }
      yield* discardUnviewed(previous?.threadIds.filter((id) => !threadIds.includes(id)) ?? []);
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  const disconnectClient = Effect.fn("TemporaryThreadService.disconnectClient")(
    function* (identity: TemporaryThreadClientIdentity) {
      for (const [viewId, view] of views) {
        if (!sameIdentity(view.identity, identity) || view.background || view.disconnected)
          continue;
        const expiry = yield* Effect.sleep("30 seconds").pipe(
          Effect.andThen(
            gate.withPermits(1)(
              Effect.gen(function* () {
                const current = views.get(viewId);
                if (
                  current?.generation !== view.generation ||
                  !current.disconnected ||
                  current.background
                )
                  return;
                views.set(viewId, { ...current, threadIds: [], expiry: undefined });
                yield* discardUnviewed(current.threadIds);
              }),
            ),
          ),
          Effect.tapError((cause) =>
            Effect.logError("Temporary thread disconnect cleanup failed", {
              operation: cause.operation,
            }),
          ),
          Effect.retry({}),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        views.set(viewId, { ...view, disconnected: true, expiry });
      }
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  const keep = Effect.fn("TemporaryThreadService.keep")(
    function* (input: { readonly threadId: ThreadId; readonly commandId: CommandId }) {
      if (state.discarding.has(input.threadId) || (yield* storage.isDiscarded(input.threadId))) {
        return yield* new TemporaryThreadServiceError({
          operation: "keep",
          threadId: input.threadId,
          cause: "Thread is being discarded.",
        });
      }
      const family = yield* storage.family(input.threadId);
      yield* state.commands.withLock(
        family[0] ?? input.threadId,
        storage.keep(input).pipe(Effect.mapError(mapError("keep", input.threadId))),
      );
      for (const id of family) {
        const timer = unowned.get(id);
        unowned.delete(id);
        if (timer !== undefined) yield* Fiber.interrupt(timer);
      }
      for (const [viewId, view] of views) {
        views.set(viewId, {
          ...view,
          threadIds: view.threadIds.filter((id) => !family.includes(id)),
        });
      }
      return { threadId: input.threadId };
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  yield* storage.changes.pipe(
    Stream.runForEach((change) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (change.type !== "registered") return;
          for (const id of change.threadIds) {
            if (unowned.has(id) || hasView(yield* storage.family(id))) continue;
            const timer = yield* Effect.sleep("30 seconds").pipe(
              Effect.andThen(
                gate.withPermits(1)(
                  Effect.gen(function* () {
                    unowned.delete(id);
                    yield* discardUnviewed([id]);
                  }),
                ),
              ),
              Effect.tapError((cause) =>
                Effect.logError("Temporary thread unowned cleanup failed", {
                  operation: cause.operation,
                }),
              ),
              Effect.retry({}),
              Effect.forkIn(scope, { startImmediately: true }),
            );
            unowned.set(id, timer);
          }
        }),
      ),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  );

  return TemporaryThreadService.of({
    updateViews,
    disconnectClient,
    keep,
    discard: Effect.fn("TemporaryThreadService.discard")((threadId: ThreadId) =>
      gate.withPermits(1)(discardUnlocked(threadId)),
    ),
  });
});

export const layer = Layer.effect(TemporaryThreadService, make);

export const layerCleanup = Layer.effect(
  TemporaryThreadCleanup,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const resources = yield* ResourceCleanupService.ResourceCleanupService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const state = yield* TemporaryThreadLifecycleState;
    return TemporaryThreadCleanup.of({
      stopAndTeardown: Effect.fn("TemporaryThreadCleanup.stopAndTeardown")(
        function* (threadIds: ReadonlyArray<ThreadId>) {
          const commands: Array<CommandId> = [];
          for (const threadId of threadIds.toReversed()) {
            yield* Effect.forEach(state.preparations.get(threadId) ?? [], Fiber.interrupt, {
              discard: true,
            });
            if ((yield* projections.getThreadShell(threadId)) === null) continue;
            const projection = yield* orchestrator.getThreadRecords(threadId, ["providerSessions"]);
            const stopCommandId = CommandId.make(`temporary-discard:stop:${threadId}`);
            commands.push(stopCommandId);
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId,
              commandId: stopCommandId,
              stopDelegatedTasks: false,
              reason: "Temporary thread closed.",
            });
            for (const session of projection.providerSessions) {
              yield* sessions.detach({
                providerSessionId: session.id,
                threadId,
                revokeMcpCredential: true,
                detail: "Temporary thread closed.",
              });
            }
            const deleteCommandId = CommandId.make(`temporary-discard:delete:${threadId}`);
            commands.push(deleteCommandId);
            yield* orchestrator.dispatch({
              type: "thread.delete",
              threadId,
              commandId: deleteCommandId,
            });
          }
          yield* worker.drain();
          for (const commandId of commands) {
            for (const effect of yield* outbox.listByCommandId(commandId)) {
              yield* outbox.awaitSettled(effect.id);
            }
          }
          for (const threadId of threadIds) {
            yield* resources.cleanupScheduledTasks(threadId);
            yield* resources.cleanupTerminals(threadId);
            yield* resources.cleanupPreviews(threadId);
            yield* resources.cleanupCommandOutput(threadId);
          }
        },
        Effect.mapError(
          (cause) => new TemporaryThreadServiceError({ operation: "discard", cause }),
        ),
      ),
    });
  }),
);
