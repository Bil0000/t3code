import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export interface VcsRefsInvalidationTarget {
  readonly environmentId: EnvironmentId;
}

export interface CachedVcsRefsInvalidationTarget extends VcsRefsInvalidationTarget {
  readonly cwd: string;
}

export interface VcsRefsCacheState {
  readonly revision: number;
  readonly persistedCacheReadable: boolean;
}

const stateByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-state:${environmentId}`)),
);
const historyRevisionByRepository = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.withLabel(`environment-data:vcs:history-revision:${key}`)),
);
const persistenceLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

export function vcsRefsCacheStateAtom(target: VcsRefsInvalidationTarget) {
  return stateByEnvironment(target.environmentId);
}

export function vcsHistoryRevisionAtom(
  target: CachedVcsRefsInvalidationTarget,
): Atom.Writable<number, number> {
  return historyRevisionByRepository(JSON.stringify([target.environmentId, target.cwd]));
}

export function invalidateVcsRefs(
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
  persistedCacheReadable?: boolean,
  invalidateHistory = true,
): void {
  registry.update(vcsRefsCacheStateAtom(target), (state) => ({
    revision: state.revision + 1,
    persistedCacheReadable: persistedCacheReadable ?? state.persistedCacheReadable,
  }));
  if (invalidateHistory)
    registry.update(vcsHistoryRevisionAtom(target), (revision) => revision + 1);
}

export function withVcsRefsPersistenceLock<A, E, R>(
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return persistenceLock.withPermit(environmentId)(effect);
}

/**
 * Clears persisted snapshots and then restarts live ref streams while holding
 * the same lock used by generation-checked refresh writes. Clearing first
 * prevents the restarted stream from rehydrating the invalidated snapshot. A
 * refresh that wins the lock is cleared afterward; one that loses observes the
 * new revision and cannot repersist its pre-mutation result.
 */
export const invalidateCachedVcsRefs = Effect.fn("VcsRefsState.invalidateCached")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
  invalidateHistory = true,
) {
  const cache = yield* EnvironmentCacheStore;
  yield* withVcsRefsPersistenceLock(
    target.environmentId,
    Effect.gen(function* () {
      const persistedCacheReadable = yield* cache.clearVcsRefs(target.environmentId).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not remove invalidated cached Git refs.").pipe(
            Effect.annotateLogs({
              environmentId: target.environmentId,
              cwd: target.cwd,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
      invalidateVcsRefs(registry, target, persistedCacheReadable, invalidateHistory);
    }),
  );
});
