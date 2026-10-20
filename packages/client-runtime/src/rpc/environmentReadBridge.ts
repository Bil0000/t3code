import {
  ENVIRONMENT_READ_WS_METHODS,
  EnvironmentReadRequest,
  EnvironmentReadResult,
  EnvironmentReadError,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  sessionGrantsScope,
  type EnvironmentId,
  type EnvironmentReadResponse,
  type EnvironmentReadStreamEvent,
  type EnvironmentReadTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { AgentThreadReadPermissions } from "../connection/agentThreadReadPermissions.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { gitHubRoutingConnectionKey } from "../connection/githubRoutingPermissions.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import { requestGuarded, RpcPermissionGuard } from "./client.ts";
import type { RpcSession } from "./session.ts";

type ReadEvent = Extract<EnvironmentReadStreamEvent, { readonly type: "request" }>;
type ReadResponse = EnvironmentReadResponse["response"];

const encodeResult = Schema.encodeSync(Schema.fromJsonString(EnvironmentReadResult));
const isReadRequest = Schema.is(EnvironmentReadRequest);
const isReadResult = Schema.is(EnvironmentReadResult);
const isReadError = Schema.is(EnvironmentReadError);

const failure = (code: Extract<ReadResponse, { status: "error" }>["code"]): ReadResponse => ({
  status: "error",
  code,
});

const currentSession = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
});

const checkSavedIdentity = Effect.fn("AgentThreadRead.checkSavedIdentity")(function* (
  entry: ConnectionCatalogEntry,
) {
  for (const route of [
    { target: entry.target, profile: entry.profile },
    ...(entry.alternateRoutes ?? []),
  ]) {
    if (route.target._tag !== "SshConnectionTarget") continue;
    const profiles = yield* Effect.serviceOption(ConnectionProfileStore);
    if (Option.isNone(profiles)) return false;
    const profile = yield* profiles.value
      .get(route.target.connectionId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (
      gitHubRoutingConnectionKey({ ...entry, ...route }) !==
      gitHubRoutingConnectionKey({ ...entry, ...route, profile })
    )
      return false;
  }
  return true;
});

const authorizeRead = Effect.fn("AgentThreadRead.authorizeRead")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return yield* new EnvironmentReadError({ code: "offline" });
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const session = yield* fetchEnvironmentSessionState({
    prepared: prepared.value,
    signer,
    remoteAuthorization,
  });
  if (!sessionGrantsScope(session, "orchestration:read"))
    return yield* new EnvironmentAuthorizationError({
      ...authScopeRequiredResponse("orchestration:read"),
      message: "This connection requires orchestration:read.",
    });
});

export const respondToEnvironmentRead = Effect.fn("AgentThreadRead.respond")(function* (
  sourceEnvironmentId: EnvironmentId,
  sourceSession: RpcSession,
  event: ReadEvent,
) {
  const registry = yield* EnvironmentRegistry;
  const permissions = yield* AgentThreadReadPermissions;
  const allowed = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const source = entries.get(sourceEnvironmentId);
    const destination = entries.get(event.environmentId);
    if (source === undefined || destination === undefined) return false;
    return (
      source.enabled &&
      destination.enabled &&
      (yield* permissions.get(source, destination)) &&
      (yield* checkSavedIdentity(source)) &&
      (yield* checkSavedIdentity(destination))
    );
  });
  return yield* Effect.gen(function* () {
    if (!(yield* allowed)) return failure("permission-denied");
    if ((yield* registry.run(sourceEnvironmentId, currentSession)) !== sourceSession)
      return failure("offline");
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(event.environmentId);
    if (entry?.unsupportedReason !== undefined) return failure("unsupported");
    const destinationSession = yield* registry.run(event.environmentId, currentSession);
    if (destinationSession === null) return failure("offline");
    const config = yield* destinationSession.initialConfig;
    if (config.environment.environmentId !== event.environmentId)
      return failure("invalid-response");
    if (!isReadRequest(event.request)) return failure("unsupported");
    const result = yield* registry.run(
      event.environmentId,
      authorizeRead().pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (!(yield* allowed))
              return yield* new EnvironmentReadError({ code: "permission-denied" });
            if ((yield* currentSession) !== destinationSession)
              return yield* new EnvironmentReadError({ code: "offline" });
          }),
        ),
        Effect.andThen(requestGuarded(ENVIRONMENT_READ_WS_METHODS.read, event.request)),
        Effect.provideService(RpcPermissionGuard, {
          authorize: (_id, method) =>
            method === ENVIRONMENT_READ_WS_METHODS.read
              ? Effect.void
              : Effect.fail(
                  new EnvironmentAuthorizationError({
                    ...authScopeRequiredResponse("orchestration:read"),
                    message: "Only thread reads can use this bridge.",
                  }),
                ),
        }),
      ),
    );
    if (!(yield* allowed)) return failure("permission-denied");
    if (
      (yield* registry.run(event.environmentId, currentSession)) !== destinationSession ||
      (yield* registry.run(sourceEnvironmentId, currentSession)) !== sourceSession
    )
      return failure("offline");
    if (!isReadResult(result) || result.operation !== event.request.operation)
      return failure("invalid-response");
    if (new TextEncoder().encode(encodeResult(result)).byteLength > 512 * 1024)
      return failure("too-large");
    return { status: "ok", result } satisfies ReadResponse;
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catch((error): Effect.Effect<ReadResponse> => {
      if (isReadError(error)) return Effect.succeed(failure(error.code));
      if (
        error._tag === "EnvironmentAuthorizationError" ||
        error._tag === "EnvironmentAuthInvalidError" ||
        error._tag === "EnvironmentOperationForbiddenError"
      )
        return Effect.succeed(failure("permission-denied"));
      if (error._tag === "TimeoutError") return Effect.succeed(failure("timeout"));
      if (error._tag === "RpcClientError" && error.reason._tag === "RpcClientDefect")
        return Effect.succeed(failure("unsupported"));
      return Effect.succeed(failure("offline"));
    }),
  );
});

export const runEnvironmentReadBridge = Effect.fn("AgentThreadRead.run")(function* () {
  const registry = yield* EnvironmentRegistry;
  const permissions = yield* AgentThreadReadPermissions;
  const clientId = `thread-read-${yield* Clock.currentTimeMillis}-${yield* Random.nextInt}`;
  const failedSessions = new WeakSet<RpcSession>();
  let revision = 0;
  const snapshot = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(registry.entries);
    return yield* Effect.forEach([...entries.values()], (entry) =>
      registry
        .run(
          entry.target.environmentId,
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor;
            return {
              entry,
              session: yield* currentSession,
              state: yield* SubscriptionRef.get(supervisor.state),
              revision,
            };
          }),
        )
        .pipe(Effect.orElseSucceed(() => ({ entry, session: null, state: null, revision }))),
    );
  });
  type EnvironmentSnapshot = Effect.Success<typeof snapshot>[number];
  const subscriptions = new Map<
    EnvironmentId,
    {
      source: EnvironmentSnapshot;
      destinations: EnvironmentSnapshot[];
      fiber: Fiber.Fiber<void>;
    }
  >();
  yield* Stream.zipLatest(SubscriptionRef.changes(registry.entries), permissions.changes).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        revision++;
      }),
    ),
    Stream.switchMap(() =>
      Stream.unwrap(
        SubscriptionRef.get(registry.entries).pipe(
          Effect.map((entries) =>
            Stream.mergeAll(
              [...entries.keys()].map((id) =>
                registry
                  .runStream(
                    id,
                    Stream.unwrap(
                      EnvironmentSupervisor.pipe(
                        Effect.map((supervisor) =>
                          Stream.merge(
                            SubscriptionRef.changes(supervisor.session),
                            SubscriptionRef.changes(supervisor.state),
                          ),
                        ),
                      ),
                    ),
                  )
                  .pipe(Stream.catch(() => Stream.empty)),
              ),
              { concurrency: "unbounded" },
            ),
          ),
        ),
      ),
    ),
    Stream.mapEffect(() => snapshot),
    Stream.changesWith(
      (a, b) =>
        a.length === b.length &&
        a.every((value, index) => {
          const other = b[index];
          return (
            other !== undefined &&
            value.revision === other.revision &&
            value.entry === other.entry &&
            value.session === other.session &&
            value.state?.phase === other.state?.phase
          );
        }),
    ),
    Stream.mapEffect((environments) =>
      Effect.gen(function* () {
        const active = new Set<EnvironmentId>();
        for (const source of environments) {
          const session = source.session;
          if (
            !source.entry.enabled ||
            source.entry.unsupportedReason !== undefined ||
            session === null ||
            failedSessions.has(session)
          )
            continue;
          const targets: EnvironmentReadTarget[] = [];
          const destinations: EnvironmentSnapshot[] = [];
          for (const destination of environments) {
            if (!(yield* permissions.get(source.entry, destination.entry))) continue;
            if (
              !(yield* checkSavedIdentity(source.entry)) ||
              !(yield* checkSavedIdentity(destination.entry))
            )
              continue;
            const state = destination.state;
            destinations.push(destination);
            targets.push({
              environmentId: destination.entry.target.environmentId,
              name: destination.entry.target.label.trim().slice(0, 200) || "Environment",
              status:
                destination.entry.unsupportedReason !== undefined
                  ? "unsupported"
                  : state?.phase === "blocked" && state.lastFailure?.reason === "permission"
                    ? "permission-denied"
                    : destination.entry.enabled && destination.session !== null
                      ? "online"
                      : "offline",
            });
            if (targets.length === 100) break;
          }
          if (targets.length === 0) continue;
          const sourceId = source.entry.target.environmentId;
          active.add(sourceId);
          const previous = subscriptions.get(sourceId);
          if (
            previous?.source.entry === source.entry &&
            previous.source.session === session &&
            previous.destinations.length === destinations.length &&
            previous.destinations.every((value, index) => {
              const other = destinations[index];
              return (
                other !== undefined &&
                value.entry === other.entry &&
                value.session === other.session &&
                value.state?.phase === other.state?.phase &&
                value.state?.lastFailure?.reason === other.state?.lastFailure?.reason
              );
            })
          )
            continue;
          if (previous !== undefined) yield* Fiber.interrupt(previous.fiber);
          let connectionId: string | null = null;
          const fiber = yield* Stream.suspend(() => {
            connectionId = null;
            return session.client[ENVIRONMENT_READ_WS_METHODS.subscribe]({
              clientId,
              environments: targets,
            });
          }).pipe(
            Stream.mapEffect(
              (event) => {
                if (event.type === "connected") {
                  connectionId = event.connectionId;
                  return Effect.void;
                }
                if (event.connectionId !== connectionId) return Effect.void;
                return respondToEnvironmentRead(
                  source.entry.target.environmentId,
                  session,
                  event,
                ).pipe(
                  Effect.flatMap((response) =>
                    session.client[ENVIRONMENT_READ_WS_METHODS.respond]({
                      clientId,
                      connectionId: event.connectionId,
                      requestId: event.requestId,
                      response,
                    }).pipe(Effect.timeout("3 seconds")),
                  ),
                  Effect.ignore,
                );
              },
              { concurrency: 4 },
            ),
            Stream.retry((schedule) =>
              schedule(Schedule.exponential("1 second")).pipe(
                Schedule.modifyDelay(({ duration }) =>
                  Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                ),
                Schedule.while(
                  ({ input }) =>
                    input._tag === "RpcClientError" && input.reason._tag !== "RpcClientDefect",
                ),
              ),
            ),
            Stream.catch(() => {
              failedSessions.add(session);
              return Stream.empty;
            }),
            Stream.runDrain,
            Effect.forkScoped,
          );
          subscriptions.set(sourceId, { source, destinations, fiber });
        }
        for (const [sourceId, subscription] of subscriptions) {
          if (active.has(sourceId)) continue;
          yield* Fiber.interrupt(subscription.fiber);
          subscriptions.delete(sourceId);
        }
      }),
    ),
    Stream.runDrain,
    Effect.scoped,
  );
});
