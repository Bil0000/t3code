export interface ProviderReplayGate {
  readonly beforeEmit: (label: string | undefined, signal?: AbortSignal) => Promise<void>;
  readonly hasReached: (label: string) => boolean;
  readonly waitUntilReached: (label: string) => Promise<boolean>;
  readonly release: (label: string) => boolean;
  readonly releaseAll: () => void;
}

interface GateState {
  reached: boolean;
  released: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly arrival: PromiseWithResolvers<void>;
}

export function makeProviderReplayGate(labels: ReadonlyArray<string>): ProviderReplayGate {
  const states = new Map<string, GateState>();
  for (const label of labels) {
    if (states.has(label)) {
      throw new Error(`Duplicate provider replay gate label ${label}.`);
    }
    let resolve = () => {};
    const promise = new Promise<void>((resume) => {
      resolve = resume;
    });
    states.set(label, {
      reached: false,
      released: false,
      promise,
      resolve,
      arrival: Promise.withResolvers<void>(),
    });
  }

  return {
    beforeEmit: (label, signal) => {
      if (label === undefined) {
        return Promise.resolve();
      }
      const state = states.get(label);
      if (state === undefined) {
        return Promise.resolve();
      }
      state.reached = true;
      state.arrival.resolve();
      if (signal === undefined) {
        return state.promise;
      }
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const stopWaiting = () => resolve();
        signal.addEventListener("abort", stopWaiting, { once: true });
        void state.promise.then(() => {
          signal.removeEventListener("abort", stopWaiting);
          resolve();
        });
      });
    },
    hasReached: (label) => states.get(label)?.reached ?? false,
    waitUntilReached: async (label) => {
      const state = states.get(label);
      if (state === undefined) return false;
      await state.arrival.promise;
      return true;
    },
    release: (label) => {
      const state = states.get(label);
      if (state === undefined || state.released) {
        return false;
      }
      state.released = true;
      state.resolve();
      return true;
    },
    releaseAll: () => {
      for (const state of states.values()) {
        if (state.released) {
          continue;
        }
        state.released = true;
        state.resolve();
      }
    },
  };
}
