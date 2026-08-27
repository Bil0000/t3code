import { ModelSelection, TextGenerationError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { SideQuestionGenerationResult } from "./TextGeneration.ts";

type SideQuestionInput = {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly question: string;
  readonly context: string;
  readonly modelSelection: ModelSelection;
};

export class SideQuestionCoordinator extends Context.Service<
  SideQuestionCoordinator,
  {
    readonly run: <R>(
      input: SideQuestionInput,
      effect: Effect.Effect<SideQuestionGenerationResult, TextGenerationError, R>,
    ) => Effect.Effect<SideQuestionGenerationResult, TextGenerationError, R>;
    readonly cancel: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<boolean>;
  }
>()("t3/textGeneration/SideQuestionCoordinator") {}

type SideQuestionFlight = {
  readonly result: Deferred.Deferred<SideQuestionGenerationResult, TextGenerationError>;
  readonly cancel: Deferred.Deferred<void>;
  readonly requestIds: ReadonlySet<string>;
};

type SideQuestionRequest = {
  readonly threadId: ThreadId;
  readonly requestKey: string;
  readonly cancel: Deferred.Deferred<void>;
};

type SideQuestionsInFlight = {
  readonly flights: Map<ThreadId, Map<string, SideQuestionFlight>>;
  readonly requests: Map<string, SideQuestionRequest>;
  readonly cancelledRequests: ReadonlySet<string>;
};

const encodeRequestKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      question: Schema.String,
      context: Schema.String,
      modelSelection: ModelSelection,
    }),
  ),
);

const requestIndexKey = (threadId: ThreadId, requestId: string) => `${threadId}\u0000${requestId}`;

const MAX_EARLY_CANCELLATIONS = 1_024;

export const make: Effect.Effect<SideQuestionCoordinator["Service"], never, Scope.Scope> =
  Effect.gen(function* SideQuestionCoordinatorMake() {
    const scope = yield* Effect.scope;
    const inFlight = yield* Ref.make<SideQuestionsInFlight>({
      flights: new Map(),
      requests: new Map(),
      cancelledRequests: new Set(),
    });

    const cancelRequest = Effect.fn("SideQuestionCoordinator.cancelRequest")(function* (
      input: Parameters<SideQuestionCoordinator["Service"]["cancel"]>[0],
      rememberMissing: boolean,
    ) {
      const indexKey = requestIndexKey(input.threadId, input.requestId);
      const [request, providerCancel] = yield* Ref.modify<
        SideQuestionsInFlight,
        readonly [SideQuestionRequest | undefined, Deferred.Deferred<void> | undefined]
      >(inFlight, (current) => {
        const request = current.requests.get(indexKey);
        if (!request || request.threadId !== input.threadId) {
          if (!rememberMissing || current.cancelledRequests.has(indexKey)) {
            return [[undefined, undefined] as const, current];
          }
          const cancelledRequests = new Set(current.cancelledRequests);
          cancelledRequests.add(indexKey);
          if (cancelledRequests.size > MAX_EARLY_CANCELLATIONS) {
            const oldest = cancelledRequests.values().next().value;
            if (oldest) cancelledRequests.delete(oldest);
          }
          return [[undefined, undefined] as const, { ...current, cancelledRequests }];
        }

        const threadFlights = current.flights.get(input.threadId);
        const flight = threadFlights?.get(request.requestKey);
        const nextRequests = new Map(current.requests);
        nextRequests.delete(indexKey);
        if (!flight || !flight.requestIds.has(input.requestId)) {
          return [[request, undefined] as const, { ...current, requests: nextRequests }];
        }

        const nextRequestIds = new Set(flight.requestIds);
        nextRequestIds.delete(input.requestId);
        const nextThreadFlights = new Map(threadFlights);
        let providerCancel: Deferred.Deferred<void> | undefined;
        if (nextRequestIds.size === 0) {
          nextThreadFlights.delete(request.requestKey);
          providerCancel = flight.cancel;
        } else {
          nextThreadFlights.set(request.requestKey, { ...flight, requestIds: nextRequestIds });
        }
        const nextFlights = new Map(current.flights);
        if (nextThreadFlights.size === 0) nextFlights.delete(input.threadId);
        else nextFlights.set(input.threadId, nextThreadFlights);
        return [
          [request, providerCancel] as const,
          { ...current, flights: nextFlights, requests: nextRequests },
        ];
      });

      if (!request) return true;
      yield* Deferred.succeed(request.cancel, undefined);
      if (providerCancel) yield* Deferred.succeed(providerCancel, undefined);
      return true;
    });

    const cancel: SideQuestionCoordinator["Service"]["cancel"] = Effect.fn(
      "SideQuestionCoordinator.cancel",
    )(function* (input) {
      return yield* cancelRequest(input, true);
    });

    const run: SideQuestionCoordinator["Service"]["run"] = Effect.fn("SideQuestionCoordinator.run")(
      (input, effect) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const candidateResult = yield* Deferred.make<
              SideQuestionGenerationResult,
              TextGenerationError
            >();
            const candidateProviderCancel = yield* Deferred.make<void>();
            const subscriberCancel = yield* Deferred.make<void>();
            const requestKey = encodeRequestKey({
              question: input.question,
              context: input.context,
              modelSelection: input.modelSelection,
            });
            const [flight, ownsRequest] = yield* Ref.modify<
              SideQuestionsInFlight,
              readonly [SideQuestionFlight | null, boolean]
            >(inFlight, (current) => {
              const indexKey = requestIndexKey(input.threadId, input.requestId);
              if (current.cancelledRequests.has(indexKey)) {
                const cancelledRequests = new Set(current.cancelledRequests);
                cancelledRequests.delete(indexKey);
                return [[null, false] as const, { ...current, cancelledRequests }];
              }
              if (current.requests.has(indexKey)) {
                return [[null, false] as const, current];
              }
              const threadFlights = current.flights.get(input.threadId);
              const existing = threadFlights?.get(requestKey);
              const flight = existing
                ? { ...existing, requestIds: new Set(existing.requestIds).add(input.requestId) }
                : {
                    result: candidateResult,
                    cancel: candidateProviderCancel,
                    requestIds: new Set([input.requestId]),
                  };
              const nextThreadFlights = new Map(threadFlights);
              nextThreadFlights.set(requestKey, flight);
              const nextFlights = new Map(current.flights);
              nextFlights.set(input.threadId, nextThreadFlights);
              const nextRequests = new Map(current.requests);
              nextRequests.set(requestIndexKey(input.threadId, input.requestId), {
                threadId: input.threadId,
                requestKey,
                cancel: subscriberCancel,
              });
              return [
                [flight, !existing] as const,
                { ...current, flights: nextFlights, requests: nextRequests },
              ];
            });

            if (!flight) return yield* Effect.interrupt;

            if (ownsRequest) {
              const generation = Effect.raceFirst(
                effect,
                Deferred.await(flight.cancel).pipe(Effect.andThen(Effect.interrupt)),
              );
              yield* Deferred.into(generation, flight.result).pipe(
                Effect.ensuring(
                  Ref.update(inFlight, (current) => {
                    const threadFlights = current.flights.get(input.threadId);
                    const currentFlight = threadFlights?.get(requestKey);
                    if (currentFlight?.result !== flight.result) return current;

                    const nextThreadFlights = new Map(threadFlights);
                    nextThreadFlights.delete(requestKey);
                    const nextFlights = new Map(current.flights);
                    if (nextThreadFlights.size === 0) nextFlights.delete(input.threadId);
                    else nextFlights.set(input.threadId, nextThreadFlights);
                    const nextRequests = new Map(current.requests);
                    for (const requestId of currentFlight.requestIds) {
                      nextRequests.delete(requestIndexKey(input.threadId, requestId));
                    }
                    return { ...current, flights: nextFlights, requests: nextRequests };
                  }),
                ),
                Effect.forkIn(scope),
              );
            }

            return yield* restore(
              Effect.raceFirst(
                Deferred.await(flight.result),
                Deferred.await(subscriberCancel).pipe(Effect.andThen(Effect.interrupt)),
              ).pipe(Effect.ensuring(cancelRequest(input, false))),
            );
          }),
        ),
    );

    return SideQuestionCoordinator.of({ run, cancel });
  });

export const layer = Layer.effect(SideQuestionCoordinator, make);
