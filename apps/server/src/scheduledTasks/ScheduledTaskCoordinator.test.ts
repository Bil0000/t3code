import { expect, it } from "@effect/vitest";
import { ScheduledTaskConfigureFailoverInput } from "@t3tools/contracts";
import { RelayScheduledTaskConfigureRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ScheduledTaskCoordinator from "./ScheduledTaskCoordinator.ts";

const input = Schema.decodeUnknownSync(ScheduledTaskConfigureFailoverInput)({
  groupId: "8f580abe-e99c-46db-a6e3-d93f2b2c10e8",
  revision: "af217cd0-325f-4625-8354-ccbd6300cb21",
  expectedRevision: null,
  environmentIds: ["primary", "backup"],
  timeZone: "UTC",
  schedule: { type: "interval", everyMs: 60_000 },
});
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayScheduledTaskConfigureRequest),
);
const secrets = Layer.mock(ServerSecretStore)({
  get: (key) =>
    Effect.succeed(
      Option.fromNullishOr(
        {
          [RELAY_URL_SECRET]: "https://relay.test",
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET]: "test-credential",
          [CLOUD_LINKED_USER_ID]: "test-user",
        }[key],
      ),
    ).pipe(Effect.map(Option.map((value) => new TextEncoder().encode(value)))),
});

it.effect(
  "recovers only a paused configure conflict and requires an explicit revision retry",
  () => {
    let enabled = false;
    let retry = false;
    const state = {
      ...input,
      revision: "ee5b2dbf-00d3-4ea0-9531-d9b1e5b95206",
      enabled: false,
      nextRunAt: "2026-09-18T00:00:00.000Z",
    };
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (retry) {
        expect(String(url)).toContain("/configure");
        const request = decodeRequest(await new Response(init?.body).text());
        expect(request.expectedRevision).toBe(state.revision);
        return Response.json({ ...state, revision: request.revision });
      }
      return Response.json(
        {
          _tag: "RelayScheduledTaskRevisionConflictError",
          currentState: { ...state, enabled },
        },
        { status: 409 },
      );
    };
    return Effect.gen(function* () {
      const coordinator = yield* ScheduledTaskCoordinator.ScheduledTaskCoordinator;
      const failed = yield* Effect.result(coordinator.configure(input));
      expect(failed._tag).toBe("Failure");
      if (failed._tag !== "Failure") return;
      expect(failed.failure.recoveryFailover?.revision).toBe(state.revision);
      expect(yield* coordinator.claim(input)).toBeNull();
      const readConflict = yield* Effect.result(coordinator.get(input));
      expect(readConflict._tag).toBe("Failure");
      if (readConflict._tag === "Failure")
        expect(readConflict.failure.recoveryFailover).toBeUndefined();
      enabled = true;
      const activeConflict = yield* Effect.result(coordinator.configure(input));
      expect(activeConflict._tag).toBe("Failure");
      if (activeConflict._tag === "Failure")
        expect(activeConflict.failure.recoveryFailover).toBeUndefined();
      retry = true;
      const recovered = yield* coordinator.configure({
        ...input,
        expectedRevision: failed.failure.recoveryFailover!.revision,
      });
      expect(recovered.enabled).toBe(false);
      expect(recovered.revision).toBe(input.revision);
    }).pipe(
      Effect.provide(ScheduledTaskCoordinator.layer.pipe(Layer.provide(secrets))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  },
);

it.effect("disables failover when no Connect credentials are available", () =>
  Effect.gen(function* () {
    const coordinator = yield* ScheduledTaskCoordinator.make;
    expect(yield* coordinator.available).toBe(false);
    const result = yield* Effect.result(coordinator.configure(input));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe(
        "Automatic switching needs all selected servers linked to the same T3 Connect account.",
      );
    }
  }),
);

it.effect("allows delete retries for missing groups but rejects stale revisions", () => {
  let tag = "RelayScheduledTaskNotFoundError";
  const fetch: typeof globalThis.fetch = async () => Response.json({ _tag: tag }, { status: 409 });
  return Effect.gen(function* () {
    const coordinator = yield* ScheduledTaskCoordinator.ScheduledTaskCoordinator;
    yield* coordinator.delete(input);
    tag = "RelayScheduledTaskRevisionConflictError";
    const result = yield* Effect.result(coordinator.delete(input));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.cause).toMatchObject({
        _tag: "RelayScheduledTaskRevisionConflictError",
      });
      expect(result.failure.message).toBe(
        "This shared task changed on another server. Reload it before making changes.",
      );
    }
    yield* coordinator.delete(input, true);
  }).pipe(
    Effect.provide(ScheduledTaskCoordinator.layer.pipe(Layer.provide(secrets))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});
