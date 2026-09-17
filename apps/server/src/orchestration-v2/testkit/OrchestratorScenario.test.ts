import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { runOrchestratorV2Scenario, type OrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";

const scenario: OrchestratorV2Scenario = {
  name: "replay-gate-failure",
  commands: [],
  steps: [{ type: "release_replay_gate", label: "held-frame" }],
};
const layer = makeOrchestratorV2ReplayLayerWithRegistry(
  scenario,
  ProviderAdapterRegistry.makeLayer([]),
  { runEffectWorker: false },
);

it.effect("keeps the rejected gate error as the scenario failure cause", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      runOrchestratorV2Scenario(scenario, { replayGate: makeProviderReplayGate([]) }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "OrchestratorV2ScenarioStepError",
        cause: new Error("Unknown provider replay gate label held-frame."),
      });
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds a missing replay arrival even with TestClock and releases the gate", () =>
  Effect.gen(function* () {
    const gate = makeProviderReplayGate(["held-frame"]);
    const started = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    yield* Effect.gen(function* () {
      const resultFiber = yield* runOrchestratorV2Scenario(scenario, {
        replayGate: {
          ...gate,
          waitForReached: (label) => {
            started.resolve();
            return gate.waitForReached(label);
          },
        },
      }).pipe(provideDeterministicTestRuntime, Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      const result = yield* Fiber.join(resultFiber);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "OrchestratorV2ScenarioStepError",
          cause: { _tag: "TimeoutError" },
        });
      }
      expect(gate.hasReached("held-frame")).toBe(false);
      expect(gate.release("held-frame")).toBe(false);
      yield* Effect.promise(() => gate.beforeEmit("held-frame"));
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
