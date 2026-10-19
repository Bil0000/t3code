import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";

export const makeIssueTestRuntime = Effect.gen(function* () {
  const supervisor = {
    state: yield* SubscriptionRef.make({ phase: "connected" }),
    session: yield* SubscriptionRef.make(Option.some({})),
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  return Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
});
