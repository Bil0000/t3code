import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class WorktreeLifecycleLock extends Context.Service<
  WorktreeLifecycleLock,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/vcs/WorktreeLifecycleLock") {
  static readonly layer = Layer.effect(
    WorktreeLifecycleLock,
    Effect.map(Semaphore.make(1), (semaphore) =>
      WorktreeLifecycleLock.of({ withLock: (effect) => semaphore.withPermit(effect) }),
    ),
  );
}
