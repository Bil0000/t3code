import {
  ScheduledTaskError,
  type ScheduledTaskConfigureFailoverInput,
  type ScheduledTaskFailover,
} from "@t3tools/contracts";
import {
  RelayApi,
  RelayScheduledTaskError,
  type RelayScheduledTaskState,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";

const isRelayScheduledTaskError = Schema.is(RelayScheduledTaskError);

export class ScheduledTaskCoordinator extends Context.Service<
  ScheduledTaskCoordinator,
  {
    readonly available: Effect.Effect<boolean>;
    readonly configure: (
      input: ScheduledTaskConfigureFailoverInput,
    ) => Effect.Effect<RelayScheduledTaskState, ScheduledTaskError>;
    readonly get: (
      input: ScheduledTaskFailover,
    ) => Effect.Effect<RelayScheduledTaskState, ScheduledTaskError>;
    readonly claim: (
      input: ScheduledTaskFailover,
    ) => Effect.Effect<
      (RelayScheduledTaskState & { readonly occurrenceId: string | null }) | null,
      ScheduledTaskError
    >;
    readonly setEnabled: (
      input: ScheduledTaskFailover,
      enabled: boolean,
    ) => Effect.Effect<RelayScheduledTaskState, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskFailover,
      allowStale?: boolean,
    ) => Effect.Effect<void, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskCoordinator") {}

export const make = Effect.gen(function* () {
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const readConfig = Effect.gen(function* () {
    if (Option.isNone(secrets)) return null;
    const values = yield* Effect.forEach(
      [RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET, CLOUD_LINKED_USER_ID],
      (key) =>
        secrets.value
          .get(key)
          .pipe(Effect.map(Option.map((value) => new TextDecoder().decode(value)))),
    );
    const [url, credential, userId] = values.map(Option.getOrNull);
    return url && credential && userId ? { url, credential, userId } : null;
  }).pipe(Effect.orElseSucceed(() => null));
  const connection = Effect.gen(function* () {
    const config = yield* readConfig;
    if (config === null)
      return yield* new ScheduledTaskError({
        message:
          "Automatic switching needs all selected servers linked to the same T3 Connect account.",
      });
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: config.url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${config.credential}`),
      ),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return { client, userId: config.userId };
  });
  const coordinate = <A, E>(effect: Effect.Effect<A, E>, recoveryGroupId?: string) =>
    effect.pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) => {
        const recovery =
          isRelayScheduledTaskError(error) &&
          error.reason === "revision_conflict" &&
          error.currentState?.enabled === false &&
          error.currentState.groupId === recoveryGroupId
            ? error.currentState
            : undefined;
        return new ScheduledTaskError({
          cause: error,
          ...(recovery
            ? {
                recoveryFailover: {
                  groupId: recovery.groupId,
                  revision: recovery.revision,
                  environmentIds: recovery.environmentIds,
                  timeZone: recovery.timeZone,
                },
              }
            : {}),
          message: recovery
            ? "A paused setup was found. Save again to finish installing this task on both servers."
            : isRelayScheduledTaskError(error)
              ? {
                  not_found: "This shared task has been deleted. Remove its remaining server copy.",
                  revision_conflict:
                    "This shared task changed on another server. Reload it before making changes.",
                  not_authorized: "All task servers must be linked to the same T3 Connect account.",
                  invalid_configuration:
                    "Choose distinct linked servers and a valid schedule and time zone.",
                  persistence_failed:
                    "The shared task coordinator could not save this change. Try again.",
                }[error.reason]
              : "Could not reach the shared task coordinator. Check the T3 Connect connection.",
        });
      }),
    );
  return ScheduledTaskCoordinator.of({
    available: readConfig.pipe(Effect.map((config) => config !== null)),
    configure: Effect.fn("ScheduledTaskCoordinator.configure")(function* (input) {
      const { client, userId } = yield* connection;
      return yield* coordinate(
        client.server.configureScheduledTask({ payload: { ...input, userId } }),
        input.groupId,
      );
    }),
    get: Effect.fn("ScheduledTaskCoordinator.get")(function* (input) {
      const { client } = yield* connection;
      return yield* coordinate(
        client.server.getScheduledTask({
          payload: { groupId: input.groupId, revision: input.revision },
        }),
      );
    }),
    claim: Effect.fn("ScheduledTaskCoordinator.claim")(function* (input) {
      const { client } = yield* connection;
      return yield* coordinate(
        client.server
          .claimScheduledTask({ payload: { groupId: input.groupId, revision: input.revision } })
          .pipe(
            Effect.catchTags({
              RelayScheduledTaskError: (error) =>
                error.reason === "not_found" ||
                error.reason === "revision_conflict" ||
                error.reason === "not_authorized"
                  ? Effect.succeed(null)
                  : Effect.fail(error),
            }),
          ),
      );
    }),
    setEnabled: Effect.fn("ScheduledTaskCoordinator.setEnabled")(function* (input, enabled) {
      const { client } = yield* connection;
      return yield* coordinate(
        client.server.setScheduledTaskEnabled({
          payload: { groupId: input.groupId, revision: input.revision, enabled },
        }),
      );
    }),
    delete: Effect.fn("ScheduledTaskCoordinator.delete")(function* (input, allowStale = false) {
      const { client } = yield* connection;
      yield* coordinate(
        client.server
          .deleteScheduledTask({ payload: { groupId: input.groupId, revision: input.revision } })
          .pipe(
            Effect.catchTags({
              RelayScheduledTaskError: (error) =>
                error.reason === "not_found" || (allowStale && error.reason === "revision_conflict")
                  ? Effect.void
                  : Effect.fail(error),
            }),
          ),
      );
    }),
  });
});

export const layer = Layer.effect(ScheduledTaskCoordinator, make);
