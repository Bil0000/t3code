import { EnvironmentId, ScheduledTaskFailover } from "@t3tools/contracts";
import { RelayScheduledTaskConfigureRequest } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayScheduledTasks } from "../persistence/schema.ts";
import * as ScheduledTasks from "./ScheduledTasks.ts";

const failoverValidators = [
  Schema.is(ScheduledTaskFailover),
  Schema.is(RelayScheduledTaskConfigureRequest),
];

type Row = typeof relayScheduledTasks.$inferSelect;
const primary = { environmentId: "primary", environmentPublicKey: "primary-key" };
const backup = { environmentId: "backup", environmentPublicKey: "backup-key" };
const config: RelayScheduledTaskConfigureRequest = {
  groupId: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  expectedRevision: null,
  userId: "owner",
  environmentIds: [EnvironmentId.make("primary"), EnvironmentId.make("backup")],
  schedule: { type: "interval", everyMs: 60_000 },
  timeZone: "UTC",
};

const harness = Effect.gen(function* () {
  const mutex = yield* Semaphore.make(1);
  let clock = "2026-09-17T00:00:00.000Z";
  const rows = new Map<string, Row>();
  const links = [primary, backup].map((member) => ({
    ...member,
    userId: "owner",
    revokedAt: null as string | null,
  }));
  const dialect = new PgDialect();
  const client = Object.assign(() => Effect.sync(() => [{ now: clock }]), {
    withTransaction: mutex.withPermits(1),
  });
  const db = {
    $client: client,
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: SQL) => {
          const params = dialect.sqlToQuery(condition).params;
          if (table === relayEnvironmentLinks) {
            return Effect.sync(() =>
              links.filter(
                (link) =>
                  link.revokedAt === null &&
                  link.userId === params[0] &&
                  (params.length === 1 ||
                    (link.environmentId === params[1] && link.environmentPublicKey === params[2])),
              ),
            );
          }
          return {
            for: (lock: string) => {
              expect(lock).toBe("update");
              return Effect.sync(() => {
                const row = rows.get(String(params[0]));
                return row ? [structuredClone(row)] : [];
              });
            },
          };
        },
      }),
    }),
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Effect.sync(() => {
              if (rows.has(row.groupId)) return [];
              rows.set(row.groupId, structuredClone(row));
              return [row];
            }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (condition: SQL) =>
          Effect.sync(() => {
            const groupId = String(dialect.sqlToQuery(condition).params[0]);
            rows.set(groupId, structuredClone({ ...rows.get(groupId)!, ...patch }));
          }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  const service = yield* ScheduledTasks.ScheduledTasks.pipe(
    Effect.provide(ScheduledTasks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)))),
  );
  return {
    service,
    links,
    rows,
    at: (value: string) => {
      clock = value;
    },
  };
});

describe("scheduled task failover", () => {
  it("requires one primary and one backup in both local and relay contracts", () => {
    for (const accepts of failoverValidators) {
      expect(accepts(config)).toBe(true);
      expect(accepts({ ...config, environmentIds: [config.environmentIds[0]] })).toBe(false);
      expect(
        accepts({
          ...config,
          environmentIds: [...config.environmentIds, EnvironmentId.make("extra")],
        }),
      ).toBe(false);
    }
  });
  it.effect(
    "recovers only authorized paused configurations while keeping stale claims fenced",
    () =>
      Effect.gen(function* () {
        const { service } = yield* harness;
        yield* service.configure(primary, config);
        const updated = {
          ...config,
          expectedRevision: config.revision,
          revision: "00000000-0000-4000-8000-000000000003",
        };
        yield* service.configure(primary, updated);
        const staleEdit = { ...updated, revision: "00000000-0000-4000-8000-000000000004" };
        const recoverable = yield* Effect.flip(service.configure(primary, staleEdit));
        expect(recoverable).toMatchObject({
          _tag: "RelayScheduledTaskRevisionConflictError",
          currentState: { revision: updated.revision, enabled: false },
        });
        expect((yield* Effect.flip(service.claim(backup, config)))._tag).toBe(
          "RelayScheduledTaskRevisionConflictError",
        );
        const unauthorized = yield* Effect.flip(
          service.configure({ ...primary, environmentPublicKey: "wrong-key" }, staleEdit),
        );
        expect(unauthorized._tag).toBe("RelayScheduledTaskNotAuthorizedError");
        expect(unauthorized).not.toHaveProperty("currentState");
        yield* service.setEnabled(primary, { ...updated, enabled: true });
        expect(yield* Effect.flip(service.configure(primary, staleEdit))).not.toHaveProperty(
          "currentState",
        );
        yield* service.remove(primary, updated);
        expect(yield* Effect.flip(service.configure(primary, staleEdit))).not.toHaveProperty(
          "currentState",
        );
      }),
  );
  it.effect("rejects intervals outside the date range", () =>
    Effect.gen(function* () {
      const { service } = yield* harness;
      const error = yield* Effect.flip(
        service.configure(primary, {
          ...config,
          schedule: { type: "interval", everyMs: Number.MAX_SAFE_INTEGER },
        }),
      );
      expect(error._tag).toBe("RelayScheduledTaskInvalidConfigurationError");
    }),
  );
  it.effect("gives the primary a startup grace period before the first fixed-time run", () =>
    Effect.gen(function* () {
      const { service, at } = yield* harness;
      at("2026-09-17T00:00:55.000Z");
      const fixed = { ...config, schedule: { type: "fixed_time" as const, timeOfDay: "00:01" } };
      yield* service.configure(primary, fixed);
      yield* service.setEnabled(primary, { ...fixed, enabled: true });
      at("2026-09-17T00:01:00.000Z");
      expect((yield* service.claim(backup, fixed)).occurrenceId).toBeNull();
      at("2026-09-17T00:01:26.000Z");
      expect((yield* service.claim(backup, fixed)).occurrenceId).not.toBeNull();
    }),
  );
  it.effect(
    "retries configuration without disabling an active group or changing its next occurrence",
    () =>
      Effect.gen(function* () {
        const { service, at } = yield* harness;
        yield* service.configure(primary, config);
        yield* service.setEnabled(primary, { ...config, enabled: true });
        at("2026-09-17T00:00:30.000Z");
        const retry = yield* service.configure(primary, config);
        expect(retry.enabled).toBe(true);
        expect(retry.nextRunAt).toBe("2026-09-17T00:01:00.000Z");
        expect(
          yield* Effect.flip(
            service.configure(primary, { ...config, timeZone: "America/New_York" }),
          ),
        ).toMatchObject({ _tag: "RelayScheduledTaskRevisionConflictError" });
      }),
  );
  it.effect(
    "claims each occurrence once under concurrent requests and never repeats a lost response",
    () =>
      Effect.gen(function* () {
        const { service, at } = yield* harness;
        yield* service.configure(primary, config);
        yield* service.setEnabled(primary, { ...config, enabled: true });
        at("2026-09-17T00:01:00.000Z");
        const claims = yield* Effect.all(
          Array.from({ length: 12 }, () => service.claim(primary, config)),
          { concurrency: "unbounded" },
        );
        expect(claims.filter((claim) => claim.occurrenceId !== null)).toHaveLength(1);
        expect((yield* service.claim(primary, config)).occurrenceId).toBeNull();
        expect(claims.every((claim) => claim.nextRunAt === "2026-09-17T00:02:00.000Z")).toBe(true);
      }),
  );

  it.effect(
    "prefers the primary, fails over after silence and returns future runs to a recovered primary",
    () =>
      Effect.gen(function* () {
        const { service, at } = yield* harness;
        yield* service.configure(primary, config);
        yield* service.setEnabled(primary, { ...config, enabled: true });
        at("2026-09-17T00:00:50.000Z");
        yield* service.claim(primary, config);
        yield* service.claim(backup, config);
        at("2026-09-17T00:01:00.000Z");
        expect((yield* service.claim(backup, config)).occurrenceId).toBeNull();
        at("2026-09-17T00:01:21.000Z");
        expect((yield* service.claim(backup, config)).occurrenceId).not.toBeNull();
        expect((yield* service.claim(primary, config)).occurrenceId).toBeNull();
        at("2026-09-17T00:02:15.000Z");
        yield* service.claim(primary, config);
        at("2026-09-17T00:02:21.000Z");
        expect((yield* service.claim(backup, config)).occurrenceId).toBeNull();
        expect((yield* service.claim(primary, config)).occurrenceId).not.toBeNull();
      }),
  );

  it.effect("rejects stale configurations and stops every replica when paused or deleted", () =>
    Effect.gen(function* () {
      const { service, at } = yield* harness;
      yield* service.configure(primary, config);
      yield* service.setEnabled(primary, { ...config, enabled: true });
      const updated = {
        ...config,
        expectedRevision: config.revision,
        revision: "00000000-0000-4000-8000-000000000003",
      };
      yield* service.configure(primary, updated);
      expect((yield* Effect.flip(service.claim(backup, config)))._tag).toBe(
        "RelayScheduledTaskRevisionConflictError",
      );
      expect(
        (yield* Effect.flip(
          service.configure(primary, {
            ...updated,
            revision: "00000000-0000-4000-8000-000000000004",
          }),
        ))._tag,
      ).toBe("RelayScheduledTaskRevisionConflictError");
      yield* service.setEnabled(primary, { ...updated, enabled: true });
      yield* service.setEnabled(backup, { ...updated, enabled: false });
      at("2026-09-17T01:00:00.000Z");
      expect((yield* service.claim(primary, updated)).occurrenceId).toBeNull();
      yield* service.remove(backup, updated);
      expect((yield* Effect.flip(service.claim(primary, updated)))._tag).toBe(
        "RelayScheduledTaskNotFoundError",
      );
      expect((yield* Effect.flip(service.configure(primary, config)))._tag).toBe(
        "RelayScheduledTaskRevisionConflictError",
      );
    }),
  );

  it.effect(
    "pins ownership and environment keys and rejects revoked links and group takeover",
    () =>
      Effect.gen(function* () {
        const { service, links } = yield* harness;
        expect(
          (yield* Effect.flip(service.configure(primary, { ...config, userId: "someone-else" })))
            ._tag,
        ).toBe("RelayScheduledTaskNotAuthorizedError");
        yield* service.configure(primary, config);
        expect(
          (yield* Effect.flip(
            service.claim({ ...primary, environmentPublicKey: "replacement-key" }, config),
          ))._tag,
        ).toBe("RelayScheduledTaskNotAuthorizedError");
        expect(
          (yield* Effect.flip(
            service.get({ environmentId: "stranger", environmentPublicKey: "key" }, config),
          ))._tag,
        ).toBe("RelayScheduledTaskNotAuthorizedError");
        links[1]!.revokedAt = "2026-09-17T00:00:01.000Z";
        expect((yield* Effect.flip(service.claim(backup, config)))._tag).toBe(
          "RelayScheduledTaskNotAuthorizedError",
        );
      }),
  );

  it.effect(
    "uses relay time and the configured timezone and skips missed fixed-time occurrences",
    () =>
      Effect.gen(function* () {
        const { service, at } = yield* harness;
        const fixed = {
          ...config,
          schedule: { type: "fixed_time" as const, timeOfDay: "09:00" },
          timeZone: "America/New_York",
        };
        expect((yield* service.configure(primary, fixed)).nextRunAt).toBe(
          "2026-09-17T13:00:00.000Z",
        );
        yield* service.setEnabled(primary, { ...fixed, enabled: true });
        at("2026-09-17T13:11:00.000Z");
        const missed = yield* service.claim(backup, fixed);
        expect(missed.occurrenceId).toBeNull();
        expect(missed.nextRunAt).toBe("2026-09-18T13:00:00.000Z");
      }),
  );
});

it.effect("preserves the immediate transaction failure as the persistence error cause", () =>
  Effect.gen(function* () {
    const cause = new Error("Database unavailable");
    const db = {
      $client: Object.assign(() => Effect.succeed([]), {
        withTransaction: () => Effect.fail(cause),
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const service = yield* ScheduledTasks.make.pipe(Effect.provideService(RelayDb.RelayDb, db));
    const error = yield* Effect.flip(service.get(primary, config));
    expect(error._tag).toBe("RelayScheduledTaskPersistenceError");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Scheduled task coordination failed: persistence_failed");
  }),
);
