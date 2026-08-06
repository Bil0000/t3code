import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ENVIRONMENT_HANDOFF_PART_CHUNK_BYTES,
  EnvironmentHttpApi,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ThreadHandoffService from "./ThreadHandoffService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const EMPTY_PART = new Uint8Array(0);

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket — gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const threadHandoff = yield* ThreadHandoffService.ThreadHandoffService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const projects = yield* projectionSnapshotQuery.getShellSnapshotWithoutEnrichment();
          const threads = yield* threadManagement.getShellSnapshot();
          return {
            schemaVersion: threads.schemaVersion,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
            projects: projects.projects,
            threads: threads.threads,
            archivedThreads: threads.archivedThreads,
          } as const;
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "readHandoffPart",
        Effect.fn("environment.orchestration.readHandoffPart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const target = threadHandoff.partPath({
            handoffId: args.params.handoffId,
            kind: args.params.kind,
          });
          const exists = yield* fs
            .exists(target)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          if (!exists) {
            return yield* failEnvironmentNotFound("handoff_part_not_found");
          }
          const contents = yield* fs
            .readFile(target)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          const window = ThreadHandoffService.handoffChunkWindow({
            totalBytes: contents.length,
            offset: args.payload.offset,
            chunkBytes: ENVIRONMENT_HANDOFF_PART_CHUNK_BYTES,
          });
          return {
            offset: window.offset,
            totalBytes: contents.length,
            data: contents.slice(window.offset, window.end),
            complete: window.complete,
          };
        }),
      )
      .handle(
        "writeHandoffPart",
        Effect.fn("environment.orchestration.writeHandoffPart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const target = threadHandoff.partPath({
            handoffId: args.params.handoffId,
            kind: args.params.kind,
          });
          const staged = yield* fs.exists(target).pipe(
            Effect.flatMap((exists) => (exists ? fs.readFile(target) : Effect.succeed(EMPTY_PART))),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_handoff_part_failed", cause),
            ),
          );
          // A chunk that does not continue exactly where the staged bytes end
          // would silently produce a part with a hole in it, which would only
          // surface later as a digest mismatch or a corrupt bundle.
          if (args.payload.offset !== staged.length) {
            return yield* failEnvironmentInvalidRequest("handoff_part_offset_mismatch");
          }
          const next = new Uint8Array(staged.length + args.payload.data.length);
          next.set(staged, 0);
          next.set(args.payload.data, staged.length);
          yield* fs
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          yield* fs
            .writeFile(target, next)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          return { receivedBytes: next.length };
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* threadManagement.getThreadSnapshot(args.params.threadId).pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      );
  }),
);
