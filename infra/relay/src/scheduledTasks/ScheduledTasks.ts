import { ScheduledTaskUpsertSchedule } from "@t3tools/contracts";
import {
  RelayScheduledTaskError,
  RelayScheduledTaskNotAuthorizedError,
  RelayScheduledTaskRevisionConflictError,
  RelayScheduledTaskNotFoundError,
  RelayScheduledTaskInvalidConfigurationError,
  RelayScheduledTaskPersistenceError,
  type RelayScheduledTaskClaim,
  type RelayScheduledTaskConfigureRequest,
  type RelayScheduledTaskEnabledRequest,
  type RelayScheduledTaskReference,
  type RelayScheduledTaskState,
} from "@t3tools/contracts/relay";
import { nextScheduledRunAt } from "@t3tools/shared/scheduledTaskSchedule";
import { and, eq, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayScheduledTasks } from "../persistence/schema.ts";

type Principal = { readonly environmentId: string; readonly environmentPublicKey: string };
type Row = typeof relayScheduledTasks.$inferSelect;
type Result<A> = Effect.Effect<A, RelayScheduledTaskError>;

export class ScheduledTasks extends Context.Service<
  ScheduledTasks,
  {
    readonly configure: (
      principal: Principal,
      input: RelayScheduledTaskConfigureRequest,
    ) => Result<RelayScheduledTaskState>;
    readonly get: (
      principal: Principal,
      input: RelayScheduledTaskReference,
    ) => Result<RelayScheduledTaskState>;
    readonly setEnabled: (
      principal: Principal,
      input: RelayScheduledTaskEnabledRequest,
    ) => Result<RelayScheduledTaskState>;
    readonly remove: (principal: Principal, input: RelayScheduledTaskReference) => Result<void>;
    readonly claim: (
      principal: Principal,
      input: RelayScheduledTaskReference,
    ) => Result<RelayScheduledTaskClaim>;
  }
>()("t3code-relay/scheduledTasks/ScheduledTasks") {}

const sameSchedule = Schema.toEquivalence(ScheduledTaskUpsertSchedule);
const isScheduledTaskError = Schema.is(RelayScheduledTaskError);

const state = (row: Row): RelayScheduledTaskState => ({
  groupId: row.groupId,
  revision: row.revision,
  enabled: row.enabled,
  nextRunAt: row.nextRunAt,
  schedule: row.schedule,
  timeZone: row.timeZone,
  environmentIds: row.members.map(
    (member) => member.environmentId as RelayScheduledTaskState["environmentIds"][number],
  ),
});

const revisionConflict = (row?: Row) =>
  new RelayScheduledTaskRevisionConflictError(
    row && !row.enabled && !row.deleted ? { currentState: state(row) } : {},
  );

const nextRunAt = (row: Pick<Row, "schedule" | "timeZone">, now: string) => {
  const next = nextScheduledRunAt(
    row.schedule,
    DateTime.makeZonedUnsafe(now, { timeZone: row.timeZone }),
  );
  return next === null ? null : DateTime.formatIso(next);
};

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
    db.$client
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          isScheduledTaskError(error)
            ? error
            : new RelayScheduledTaskPersistenceError({ cause: error }),
        ),
      );
  const now = Effect.map(
    db.$client<{ now: string }>`SELECT clock_timestamp()::text AS now`,
    (rows) => DateTime.formatIso(DateTime.makeUnsafe(rows[0]!.now)),
  );
  const authorize = Effect.fnUntraced(function* (principal: Principal, row: Row) {
    if (
      !row.members.some(
        (member) =>
          member.environmentId === principal.environmentId &&
          member.publicKey === principal.environmentPublicKey,
      )
    ) {
      return yield* new RelayScheduledTaskNotAuthorizedError({});
    }
    const links = yield* db
      .select()
      .from(relayEnvironmentLinks)
      .where(
        and(
          eq(relayEnvironmentLinks.userId, row.userId),
          eq(relayEnvironmentLinks.environmentId, principal.environmentId),
          eq(relayEnvironmentLinks.environmentPublicKey, principal.environmentPublicKey),
          isNull(relayEnvironmentLinks.revokedAt),
        ),
      );
    if (links.length === 0) return yield* new RelayScheduledTaskNotAuthorizedError({});
  });
  const load = Effect.fnUntraced(function* (
    principal: Principal,
    input: RelayScheduledTaskReference,
  ) {
    const [row] = yield* db
      .select()
      .from(relayScheduledTasks)
      .where(eq(relayScheduledTasks.groupId, input.groupId))
      .for("update");
    if (!row) return yield* new RelayScheduledTaskNotFoundError({});
    yield* authorize(principal, row);
    if (row.deleted) return yield* new RelayScheduledTaskNotFoundError({});
    if (row.revision !== input.revision) return yield* revisionConflict(row);
    return row;
  });

  return ScheduledTasks.of({
    configure: Effect.fn("relay.scheduled_tasks.configure")(function* (principal, input) {
      if (
        Option.isNone(DateTime.zoneMakeNamed(input.timeZone)) ||
        new Set(input.environmentIds).size !== input.environmentIds.length ||
        !input.environmentIds.includes(
          principal.environmentId as (typeof input.environmentIds)[number],
        )
      ) {
        return yield* new RelayScheduledTaskInvalidConfigurationError({});
      }
      const links = yield* db
        .select()
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        );
      const members: Array<{ environmentId: string; publicKey: string }> = [];
      for (const environmentId of input.environmentIds) {
        const link = links.find((candidate) => candidate.environmentId === environmentId);
        if (
          !link ||
          (environmentId === principal.environmentId &&
            link.environmentPublicKey !== principal.environmentPublicKey)
        ) {
          return yield* new RelayScheduledTaskNotAuthorizedError({});
        }
        members.push({ environmentId, publicKey: link.environmentPublicKey });
      }
      const [previous] = yield* db
        .select()
        .from(relayScheduledTasks)
        .where(eq(relayScheduledTasks.groupId, input.groupId))
        .for("update");
      if (previous) {
        yield* authorize(principal, previous);
        if (previous.deleted) return yield* revisionConflict(previous);
        if (previous.revision === input.revision) {
          if (
            previous.userId === input.userId &&
            previous.timeZone === input.timeZone &&
            previous.members.length === members.length &&
            previous.members.every(
              (member, index) =>
                member.environmentId === members[index]!.environmentId &&
                member.publicKey === members[index]!.publicKey,
            ) &&
            sameSchedule(previous.schedule, input.schedule)
          )
            return state(previous);
          return yield* revisionConflict(previous);
        }
      }
      if (
        (previous?.revision ?? null) !== input.expectedRevision ||
        (previous && previous.userId !== input.userId)
      )
        return yield* revisionConflict(previous);
      const timestamp = yield* now;
      const due = yield* Effect.try({
        try: () => nextRunAt(input, timestamp),
        catch: () => new RelayScheduledTaskInvalidConfigurationError({}),
      });
      if (due === null) return yield* new RelayScheduledTaskInvalidConfigurationError({});
      const row: Row = {
        groupId: input.groupId,
        revision: input.revision,
        userId: input.userId,
        members,
        schedule: input.schedule,
        timeZone: input.timeZone,
        enabled: false,
        deleted: false,
        nextRunAt: due,
        activatedAt: null,
        heartbeats: {},
      };
      if (!previous) {
        const inserted = yield* db
          .insert(relayScheduledTasks)
          .values(row)
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return yield* new RelayScheduledTaskRevisionConflictError({});
      } else {
        yield* db
          .update(relayScheduledTasks)
          .set(row)
          .where(eq(relayScheduledTasks.groupId, input.groupId));
      }
      return state(row);
    }, transaction),
    get: Effect.fn("relay.scheduled_tasks.get")(function* (principal, input) {
      return state(yield* load(principal, input));
    }, transaction),
    setEnabled: Effect.fn("relay.scheduled_tasks.set_enabled")(function* (principal, input) {
      const row = yield* load(principal, input);
      if (row.enabled !== input.enabled) {
        row.enabled = input.enabled;
        if (input.enabled) {
          row.activatedAt = yield* now;
          row.nextRunAt = nextRunAt(row, row.activatedAt)!;
          row.heartbeats = {};
        }
        yield* db
          .update(relayScheduledTasks)
          .set(row)
          .where(eq(relayScheduledTasks.groupId, input.groupId));
      }
      return state(row);
    }, transaction),
    remove: Effect.fn("relay.scheduled_tasks.remove")(function* (principal, input) {
      yield* load(principal, input);
      yield* db
        .update(relayScheduledTasks)
        .set({ enabled: false, deleted: true, heartbeats: {} })
        .where(eq(relayScheduledTasks.groupId, input.groupId));
    }, transaction),
    claim: Effect.fn("relay.scheduled_tasks.claim")(function* (principal, input) {
      const row = yield* load(principal, input);
      const timestamp = yield* now;
      row.heartbeats[principal.environmentId] = timestamp;
      const cutoff = Date.parse(timestamp) - 30_000;
      const preferred = row.members.find(
        (member) =>
          Date.parse(row.heartbeats[member.environmentId] ?? row.activatedAt ?? timestamp) > cutoff,
      );
      let occurrenceId: string | null = null;
      if (
        row.enabled &&
        preferred?.environmentId === principal.environmentId &&
        Date.parse(row.nextRunAt) <= Date.parse(timestamp)
      ) {
        if (
          row.schedule.type !== "fixed_time" ||
          Date.parse(timestamp) - Date.parse(row.nextRunAt) <= 600_000
        ) {
          occurrenceId = `${row.groupId}:${row.revision}:${row.nextRunAt}`;
        }
        row.nextRunAt = nextRunAt(row, timestamp)!;
      }
      yield* db
        .update(relayScheduledTasks)
        .set({ heartbeats: row.heartbeats, nextRunAt: row.nextRunAt })
        .where(eq(relayScheduledTasks.groupId, input.groupId));
      return { ...state(row), occurrenceId };
    }, transaction),
  });
});

export const layer = Layer.effect(ScheduledTasks, make);
