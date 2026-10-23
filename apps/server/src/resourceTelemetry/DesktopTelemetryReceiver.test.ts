// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { UpdateRestartPolicy, UpdateRestartPolicyError } from "../updateRestartPolicy.ts";
import { describe, expect } from "vite-plus/test";

import {
  applyUpdateRestartPolicy,
  requireDesktopTelemetryWriteProgress,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});

it.effect("acknowledges the exact resume choice only after policy persistence", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const persisted = yield* Deferred.make<void>();
    const task = applyUpdateRestartPolicy({
      version: 1,
      type: "desktopUpdateRestartPolicy",
      requestId: "attempt",
      continueRunningThreads: false,
    }).pipe(
      Effect.provideService(UpdateRestartPolicy, {
        set: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(persisted))),
        capture: () => Effect.void,
        isVetoed: () => Effect.succeed(false),
      }),
    );
    const fiber = yield* task.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(persisted, undefined);
    expect(yield* Fiber.join(fiber)).toEqual({
      version: 1,
      type: "desktopUpdateRestartPolicyResult",
      requestId: "attempt",
      continueRunningThreads: false,
      accepted: true,
    });
  }),
);

it.effect("refuses the native choice when persistence fails", () =>
  Effect.gen(function* () {
    const result = yield* applyUpdateRestartPolicy({
      version: 1,
      type: "desktopUpdateRestartPolicy",
      requestId: "attempt",
      continueRunningThreads: true,
    }).pipe(
      Effect.provideService(UpdateRestartPolicy, {
        set: () => Effect.fail(new UpdateRestartPolicyError({ cause: "disk failure" })),
        capture: () => Effect.void,
        isVetoed: () => Effect.succeed(false),
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.continueRunningThreads).toBe(true);
  }),
);
