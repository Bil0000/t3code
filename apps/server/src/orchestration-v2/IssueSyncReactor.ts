import {
  CommandId,
  normalizeWorkItemLinkKey,
  type ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IssueService from "../issue/IssueService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const CLOSED_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
const encodeSyncKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number, Schema.String]),
  ),
);

export class IssueSyncReactor extends Context.Service<
  IssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IssueSyncReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;
  const lastSyncedAt = new Map<string, number>();
  const observedLinks = new Map<ThreadId, ReadonlySet<CommandId>>();
  const requestedLinks = new Map<ThreadId, Set<CommandId>>();

  const logSkipped =
    (fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("issue sync skipped", fields);

  const sweep = Effect.fn("IssueSyncReactor.sweep")(function* (
    threadId?: ThreadId,
    requested?: ReadonlySet<CommandId>,
  ) {
    const threads = yield* projections.getThreadsWithIssues(threadId);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const groups = new Map<
      string,
      Array<{
        readonly thread: ProjectionStore.ProjectionThreadIssues;
        readonly link: ThreadIssueLink;
      }>
    >();
    for (const thread of threads) {
      observedLinks.set(
        thread.id,
        new Set(
          (thread.issues ?? []).flatMap((link) => (link.linkId === undefined ? [] : [link.linkId])),
        ),
      );
      for (const link of thread.issues ?? []) {
        if (requested !== undefined && (link.linkId === undefined || !requested.has(link.linkId)))
          continue;
        const key = encodeSyncKey([
          thread.projectId,
          link.provider,
          link.repository.toLowerCase(),
          link.number,
          normalizeWorkItemLinkKey(link).url,
        ]);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }
    if (threadId === undefined) {
      for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);
      const activeThreads = new Set(threads.map((thread) => thread.id));
      for (const id of observedLinks.keys()) if (!activeThreads.has(id)) observedLinks.delete(id);
    }

    yield* Effect.forEach(
      groups,
      ([key, entries]) =>
        Effect.gen(function* () {
          const last = lastSyncedAt.get(key);
          if (
            requested === undefined &&
            entries.every(({ link }) => link.state === "closed") &&
            last !== undefined &&
            now - last < CLOSED_SYNC_INTERVAL_MS
          ) {
            return;
          }
          const first = entries[0]!;
          const url = new URL(first.link.url);
          if (url.protocol !== "https:" && url.protocol !== "http:") return;
          const ref = {
            projectId: first.thread.projectId,
            provider: first.link.provider,
            repository: first.link.repository,
            number: first.link.number,
            host: url.host,
          };
          lastSyncedAt.set(key, now);
          yield* issues.invalidate({ reference: ref });
          const detail = yield* issues.detail(ref);
          if (
            detail.projectId !== ref.projectId ||
            detail.provider !== ref.provider ||
            detail.repository.toLowerCase() !== ref.repository.toLowerCase() ||
            detail.number !== ref.number ||
            normalizeWorkItemLinkKey(detail).url !== normalizeWorkItemLinkKey(first.link).url
          ) {
            return;
          }
          for (const { thread, link } of entries) {
            if (link.title === detail.title && link.state === detail.state) continue;
            const uuid = yield* crypto.randomUUIDv4;
            yield* engine
              .dispatch({
                type: "thread.issue-link.sync",
                commandId: CommandId.make(`server:issue-sync:${thread.id}:${uuid}`),
                threadId: thread.id,
                projectId: thread.projectId,
                issue: { ...link, title: detail.title, state: detail.state },
                expectedIssue: link,
              })
              .pipe(Effect.catchCause(logSkipped({ threadId: thread.id, key })));
          }
        }).pipe(Effect.catchCause(logSkipped({ key }))),
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    Effect.suspend(() => {
      const requested = threadId === undefined ? undefined : requestedLinks.get(threadId);
      if (threadId !== undefined) requestedLinks.delete(threadId);
      return sweep(threadId, requested);
    }).pipe(Effect.catchCause(logSkipped({ threadId }))),
  );
  const start: IssueSyncReactor["Service"]["start"] = Effect.fn("IssueSyncReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type === "thread.archived" || event.type === "thread.deleted") {
            observedLinks.delete(event.threadId);
            return Effect.void;
          }
          if (event.type !== "thread.metadata-updated") return Effect.void;
          const previous = observedLinks.get(event.threadId);
          const current = new Set(
            (event.payload.issues ?? []).flatMap((issue) =>
              issue.linkId === undefined ? [] : [issue.linkId],
            ),
          );
          observedLinks.set(event.threadId, current);
          const added = [...current].filter((id) => !previous?.has(id));
          if (added.length === 0) return Effect.void;
          const pending = requestedLinks.get(event.threadId);
          if (pending !== undefined) {
            for (const id of added) pending.add(id);
            return Effect.void;
          }
          requestedLinks.set(event.threadId, new Set(added));
          return worker.enqueue(event.threadId);
        }).pipe(Effect.catchCause(logSkipped({}))),
      );
      yield* forkParked(
        worker
          .enqueue(undefined)
          .pipe(
            Effect.andThen(worker.drain),
            Effect.repeat(Schedule.spaced("1 minute")),
            Effect.asVoid,
          ),
      );
    },
  );
  return { start, drain: worker.drain } satisfies IssueSyncReactor["Service"];
});

export const layer = Layer.effect(IssueSyncReactor, make);
