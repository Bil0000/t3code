import { CommandId, normalizeWorkItemLinkKey, type ThreadIssueLink } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as IssueService from "../issue/IssueService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const OPEN_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
/** Closed issues, and open ones whose threads have all settled, change rarely. */
const SLOW_SYNC_INTERVAL_MS = 30 * 60 * 1_000;
/** An issue the tracker refuses (deleted, private, moved) is not worth asking often. */
const UNREADABLE_RETRY_MS = 30 * 60 * 1_000;
/** A missing or signed-out CLI may be fixed at any moment. */
const UNAVAILABLE_RETRY_MS = 5 * 60 * 1_000;
const READ_CONCURRENCY = 8;

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadIssues;
  readonly link: ThreadIssueLink;
}

function isUnsettled(thread: ProjectionStore.ProjectionThreadIssues): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

/** One key per issue, however many threads link it. */
function issueKeyOf(link: ThreadIssueLink): string {
  return JSON.stringify(normalizeWorkItemLinkKey(link));
}

/** How `requestSync` names an issue: the caller has a repository and number, not a URL. */
function requestKeyOf(ref: { readonly repository: string; readonly number: number }): string {
  return `${ref.repository.toLowerCase()}#${ref.number}`;
}

/**
 * Between 80% and 100% of `intervalMs`, fixed per issue, so issues read together (every one at
 * startup) do not keep coming due together.
 */
function spreadInterval(key: string, intervalMs: number): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return intervalMs * (0.8 + 0.2 * (hash / 0xffffffff));
}

/**
 * Keeps the title and state of every thread ↔ issue link current. A sweep every minute reads the
 * active threads with issue links, asks the tracker once per issue however many threads share
 * it, and writes back only what changed. A link carries its state from the moment it is made, so
 * the sweep only reads right away links without one; open issues on active threads every few
 * minutes, the rest (closed issues can reopen) rarely. `requestSync` reads an issue at once after
 * T3 changes it.
 */
export class IssueSyncReactor extends Context.Service<
  IssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly requestSync: (ref: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IssueSyncReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;

  const lastSyncedAt = new Map<string, number>();
  // When an issue that failed to read may be tried again.
  const retryAt = new Map<string, number>();
  // When a tracker whose CLI is missing or signed out may be asked again; it fails every read.
  const providerRetryAt = new Map<string, number>();
  const requested = new Set<string>();
  let sweepQueued = false;

  const isDue = (
    key: string,
    entries: ReadonlyArray<LinkEntry>,
    nowMs: number,
    wanted: ReadonlySet<string>,
  ): boolean => {
    if (entries.some(({ link }) => wanted.has(requestKeyOf(link)))) return true;
    const retry = retryAt.get(key);
    if (retry !== undefined) return nowMs >= retry;
    if (entries.some((entry) => entry.link.state === undefined)) return true;
    const last = lastSyncedAt.get(key);
    // Every link already says what it was when linked or last read; start its clock from now
    // instead of reading every issue again after a restart.
    if (last === undefined) {
      lastSyncedAt.set(key, nowMs);
      return false;
    }
    const active = entries.some(
      (entry) => entry.link.state === "open" && isUnsettled(entry.thread),
    );
    return (
      nowMs - last >= spreadInterval(key, active ? OPEN_SYNC_INTERVAL_MS : SLOW_SYNC_INTERVAL_MS)
    );
  };

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

  const commandIdFor = (threadId: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:issue-sync:${threadId}:${uuid}`)),
    );

  /** Reads through each linking project in turn, since one may resolve what another cannot. */
  const readIssue = (entries: ReadonlyArray<LinkEntry>) => {
    const { link } = entries[0]!;
    const projectIds = [...new Set(entries.map(({ thread }) => thread.projectId))];
    const attempt = (index: number): ReturnType<IssueService.IssueService["Service"]["detail"]> =>
      issues
        .detail({
          projectId: projectIds[index]!,
          provider: link.provider,
          repository: link.repository,
          number: link.number,
        })
        .pipe(
          Effect.catchTag("IssueOperationError", (error) =>
            index + 1 < projectIds.length ? attempt(index + 1) : Effect.fail(error),
          ),
        );
    return attempt(0);
  };

  const syncGroup = Effect.fn("IssueSyncReactor.syncGroup")(function* (
    key: string,
    entries: ReadonlyArray<LinkEntry>,
    nowMs: number,
  ) {
    const issue = yield* readIssue(entries);
    retryAt.delete(key);
    let written = true;
    yield* Effect.forEach(
      entries.filter(
        ({ link }) =>
          link.title !== issue.title ||
          link.state !== issue.state ||
          (link.stateReason ?? null) !== issue.stateReason,
      ),
      ({ thread, link }) =>
        commandIdFor(thread.id).pipe(
          Effect.flatMap((commandId) =>
            engine.dispatch({
              type: "thread.issue-link.sync",
              commandId,
              threadId: thread.id,
              provider: link.provider,
              repository: link.repository,
              number: link.number,
              url: link.url,
              title: issue.title,
              state: issue.state,
              stateReason: issue.stateReason,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              written = false;
            }).pipe(
              Effect.andThen(logSkipped("issue sync skipped", { threadId: thread.id, key })(cause)),
            ),
          ),
        ),
      { discard: true },
    );
    // A write that failed is tried again at the next sweep, not a full interval later.
    if (written) lastSyncedAt.set(key, nowMs);
  });

  const syncKey = (key: string, entries: ReadonlyArray<LinkEntry>, nowMs: number) => {
    const provider = entries[0]!.link.provider;
    return syncGroup(key, entries, nowMs).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (
            error._tag === "IssueUnavailableError" &&
            (error.reason === "cli-missing" || error.reason === "cli-unauthenticated")
          ) {
            providerRetryAt.set(provider, nowMs + UNAVAILABLE_RETRY_MS);
          } else {
            // A refused issue, an unsupported remote or a disabled tracker is this issue's
            // problem, and none of them clears up soon.
            retryAt.set(key, nowMs + UNREADABLE_RETRY_MS);
          }
        }),
      ),
      Effect.tapCause(() =>
        Effect.sync(() => {
          // Typed errors set their own wait above; anything else still waits.
          if ((retryAt.get(key) ?? 0) <= nowMs && (providerRetryAt.get(provider) ?? 0) <= nowMs) {
            retryAt.set(key, nowMs + UNAVAILABLE_RETRY_MS);
          }
        }),
      ),
      Effect.catchCause(logSkipped("issue sync skipped", { key })),
    );
  };

  const sweep = Effect.fn("IssueSyncReactor.sweep")(function* () {
    const wanted = new Set(requested);
    requested.clear();
    const threads = yield* projections.getThreadsWithIssues();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of threads) {
      for (const link of thread.issues ?? []) {
        const key = issueKeyOf(link);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }
    for (const map of [lastSyncedAt, retryAt]) {
      for (const key of map.keys()) if (!groups.has(key)) map.delete(key);
    }

    const dueByProvider = new Map<string, Array<[string, ReadonlyArray<LinkEntry>]>>();
    for (const [key, entries] of groups) {
      const provider = entries[0]!.link.provider;
      if (nowMs < (providerRetryAt.get(provider) ?? 0)) continue;
      if (!isDue(key, entries, nowMs, wanted)) continue;
      const due = dueByProvider.get(provider) ?? [];
      due.push([key, entries]);
      dueByProvider.set(provider, due);
    }

    // One read per tracker goes first: a missing or signed-out CLI then costs one failed call,
    // not one per issue.
    yield* Effect.forEach(
      dueByProvider,
      ([provider, due]) =>
        Effect.gen(function* () {
          const [first, ...rest] = due;
          yield* syncKey(first![0], first![1], nowMs);
          if (nowMs < (providerRetryAt.get(provider) ?? 0)) return;
          yield* Effect.forEach(rest, ([key, entries]) => syncKey(key, entries, nowMs), {
            concurrency: READ_CONCURRENCY,
            discard: true,
          });
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(() =>
    Effect.suspend(() => {
      sweepQueued = false;
      return sweep();
    }).pipe(Effect.catchCause(logSkipped("issue sync sweep failed", {}))),
  );

  const enqueueSweep = Effect.suspend(() => {
    if (sweepQueued) return Effect.void;
    sweepQueued = true;
    return worker.enqueue(undefined);
  });

  const requestSync: IssueSyncReactor["Service"]["requestSync"] = (ref) =>
    Effect.suspend(() => {
      requested.add(requestKeyOf(ref));
      return enqueueSweep;
    });

  const start: IssueSyncReactor["Service"]["start"] = Effect.fn("IssueSyncReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* enqueueSweep;
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return IssueSyncReactor.of({ start, drain: worker.drain, requestSync });
});

export const layer = Layer.effect(IssueSyncReactor, make);
