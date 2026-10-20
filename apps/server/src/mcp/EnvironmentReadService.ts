import {
  EnvironmentReadError,
  EnvironmentReadResult,
  type EnvironmentBrowseInput,
  type EnvironmentId,
  type EnvironmentReadRequest,
  type EnvironmentReadTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as EnvironmentReadBroker from "./EnvironmentReadBroker.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class EnvironmentReadService extends Context.Service<
  EnvironmentReadService,
  {
    readonly read: (
      request: EnvironmentReadRequest,
    ) => Effect.Effect<EnvironmentReadResult, EnvironmentReadError>;
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<
      { readonly environments: ReadonlyArray<EnvironmentReadTarget> },
      EnvironmentReadError
    >;
    readonly browse: (
      scope: McpInvocationScope,
      input: EnvironmentBrowseInput,
    ) => Effect.Effect<
      { readonly environmentId: EnvironmentId; readonly result: EnvironmentReadResult },
      EnvironmentReadError
    >;
  }
>()("t3/mcp/EnvironmentReadService") {}
const encodeReadResult = Schema.encodeEffect(Schema.fromJsonString(EnvironmentReadResult));

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* OrchestratorMcpService.OrchestratorMcpService;
  const search = yield* ThreadSearch.ThreadSearch;
  const broker = yield* EnvironmentReadBroker.EnvironmentReadBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const localScope: McpInvocationScope = {
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "environment-read",
    thread: undefined,
    client: undefined,
  };

  const execute = Effect.fn("EnvironmentReadService.execute")(function* (
    request: EnvironmentReadRequest,
  ): Effect.fn.Return<EnvironmentReadResult, EnvironmentReadError> {
    switch (request.operation) {
      case "project.list": {
        const snapshot = yield* projects.snapshot.pipe(
          Effect.mapError(
            (cause) => new EnvironmentReadError({ code: "invalid-response", environmentId, cause }),
          ),
        );
        const rows = snapshot.projects.filter((project) => project.deletedAt === null);
        const cursor = request.cursor ?? 0;
        const end = cursor + (request.limit ?? 20);
        return {
          operation: request.operation,
          data: { projects: rows.slice(cursor, end), nextCursor: end < rows.length ? end : null },
        };
      }
      case "project.read": {
        const project = yield* projects
          .getById(request.projectId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentReadError({ code: "invalid-response", environmentId, cause }),
            ),
          );
        if (Option.isNone(project) || project.value.deletedAt !== null)
          return yield* new EnvironmentReadError({ code: "not-found", environmentId });
        return { operation: request.operation, data: project.value };
      }
      case "thread.list":
        return {
          operation: request.operation,
          data: yield* threads.listThreads(localScope, request).pipe(
            Effect.mapError(
              (error) =>
                new EnvironmentReadError({
                  code: error.code === "invalid_request" ? "not-found" : "invalid-response",
                  environmentId,
                  cause: error,
                }),
            ),
          ),
        };
      case "thread.search":
        return {
          operation: request.operation,
          data: yield* search
            .search({ ...request, includeTitles: request.includeTitles ?? true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EnvironmentReadError({ code: "invalid-response", environmentId, cause }),
              ),
            ),
        };
      case "thread.read":
        return {
          operation: request.operation,
          data: yield* threads.readThreadHistory(request).pipe(
            Effect.mapError(
              (error) =>
                new EnvironmentReadError({
                  code: error.code === "thread_not_found" ? "not-found" : "invalid-response",
                  environmentId,
                  cause: error,
                }),
            ),
          ),
        };
    }
  });

  const read = Effect.fn("EnvironmentReadService.read")((request: EnvironmentReadRequest) =>
    execute(request).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new EnvironmentReadError({ code: "timeout", environmentId })),
      }),
      Effect.flatMap((result) =>
        encodeReadResult(result).pipe(
          Effect.mapError(
            (cause) => new EnvironmentReadError({ code: "invalid-response", environmentId, cause }),
          ),
          Effect.filterOrFail(
            (encoded) => Buffer.byteLength(encoded, "utf8") <= 512 * 1024,
            () => new EnvironmentReadError({ code: "too-large", environmentId }),
          ),
          Effect.as(result),
        ),
      ),
    ),
  );

  const assertScope = Effect.fn("EnvironmentReadService.assertScope")(function* (
    scope: McpInvocationScope,
  ) {
    if (scope.environmentId !== environmentId || !scope.capabilities.has("orchestration"))
      return yield* new EnvironmentReadError({ code: "permission-denied", environmentId });
  });
  const list = Effect.fn("EnvironmentReadService.list")(function* (scope: McpInvocationScope) {
    yield* assertScope(scope);
    const descriptor = yield* environment.getDescriptor;
    const remote = yield* broker.list(scope.client?.sessionId);
    return {
      environments: [
        { environmentId, name: descriptor.label, status: "online" as const },
        ...remote.filter((target) => target.environmentId !== environmentId),
      ],
    };
  });
  const browse = Effect.fn("EnvironmentReadService.browse")(function* (
    scope: McpInvocationScope,
    input: EnvironmentBrowseInput,
  ) {
    yield* assertScope(scope);
    const target = input.environmentId ?? environmentId;
    const result =
      target === environmentId
        ? yield* read(input.request)
        : yield* broker.invoke(scope.client?.sessionId, target, input.request);
    return { environmentId: target, result };
  });
  return EnvironmentReadService.of({ read, list, browse });
});

export const layer = Layer.effect(EnvironmentReadService, make);
