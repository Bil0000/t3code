import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import IssueTrackerBindings from "./Migrations/063_IssueTrackerBindings.ts";
import IssueTrackerBindingHost from "./Migrations/064_IssueTrackerBindingHost.ts";
import IssueTrackerAccounts from "./Migrations/065_IssueTrackerAccounts.ts";
import IssueAccountStorage from "./Migrations/066_IssueAccountStorage.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

const seedIssuePreview = Effect.fnUntraced(function* (throughId: number) {
  yield* runMigrations({ toMigrationInclusive: 62 });
  return yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        (
          [
            [63, "IssueTrackerBindings", IssueTrackerBindings],
            [64, "IssueTrackerBindingHost", IssueTrackerBindingHost],
            [65, "IssueTrackerAccounts", IssueTrackerAccounts],
            [66, "IssueAccountStorage", IssueAccountStorage],
          ] as const
        )
          .filter(([id]) => id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});

describe("Issues preview upgrade", () => {
  it.effect.each([63, 64, 65, 66])(
    "preserves data and canonical history from preview migration %s",
    (throughId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedIssuePreview(throughId);
        yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-15 00:00:00'
          WHERE migration_id >= 63`;
        const oldHistory = yield* sql<{ migration_id: number; name: string; created_at: string }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE migration_id >= 63 ORDER BY migration_id`;
        const historyBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schemaBefore = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 62 }), []);
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 63 }))));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          historyBefore,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
          schemaBefore,
        );
        if (throughId >= 65) {
          yield* sql`INSERT INTO issue_tracker_accounts
            VALUES ('linear', 'Account', 'linear.app', 'native-account')`;
        }
        const storedTracker =
          throughId === 66
            ? JSON.stringify({ tracker: "linear", connectionId: "Account" })
            : "linear";
        yield* sql`INSERT INTO issue_tracker_bindings ${sql.insert({
          project_id: "project",
          tracker: storedTracker,
          scope: "acme/ENG",
          updated_at: "2026-10-15T00:00:00Z",
          ...(throughId >= 64 ? { host: "linear.app" } : {}),
          ...(throughId >= 65 ? { connection_id: "Account" } : {}),
          ...(throughId >= 66 ? { native_tracker: "linear" } : {}),
        })}`;
        const selectedProject = { value: "project", connectionId: "Account" };
        const issue = {
          projectId: throughId === 66 ? selectedProject : "project",
          ...(throughId === 65 ? { connectionId: "Account" } : {}),
          tracker: "linear",
          key: "ENG-7",
          preserved: "issue-data",
        };
        const payload = JSON.stringify({
          issues: [issue],
          linkedPullRequest: {
            projectId: "project",
            repository: "acme/web",
            number: 42,
            url: "https://github.com/acme/web/pull/42",
          },
          preserved: "thread-data",
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json)
          VALUES ('thread', 'project', 'Thread', 'codex', 'full-access', 'default',
            '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', ${payload})`;

        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 64 }), [
          [63, "DropUnusedV1Projections"],
          [64, "CanonicalizeThreadPullRequestLinks"],
        ]);
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const shiftedHistory = yield* sql`SELECT migration_id, name, created_at
          FROM effect_sql_migrations WHERE migration_id BETWEEN 65 AND ${throughId + 2}
          ORDER BY migration_id`;
        assert.deepStrictEqual(
          shiftedHistory,
          oldHistory.map((row) => ({
            ...row,
            migration_id: row.migration_id + 2,
          })),
        );
        const bindings = yield* sql`SELECT * FROM issue_tracker_bindings`;
        assert.deepStrictEqual(bindings, [
          {
            project_id: "project",
            tracker:
              throughId >= 65
                ? JSON.stringify({ tracker: "linear", connectionId: "Account" })
                : "linear",
            native_tracker: "linear",
            scope: "acme/ENG",
            host: throughId >= 64 ? "linear.app" : null,
            connection_id: throughId >= 65 ? "Account" : null,
            updated_at: "2026-10-15T00:00:00Z",
          },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM issue_tracker_accounts`,
          throughId >= 65
            ? [
                {
                  tracker: "linear",
                  connection_id: "Account",
                  host: "linear.app",
                  account_id: "native-account",
                },
              ]
            : [],
        );
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'thread'`;
        const stored = JSON.parse(rows[0]!.payload_json);
        const { connectionId: _connectionId, ...expectedIssue } = issue;
        assert.deepStrictEqual(stored.issues, [
          {
            ...expectedIssue,
            projectId: throughId >= 65 ? selectedProject : "project",
          },
        ]);
        assert.equal(stored.preserved, "thread-data");
        assert.equal(stored.pullRequests[0].number, 42);
        assert.equal(stored.pullRequests[0].repository, "acme/web");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades released main 64 to Issues without changing released history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      const released = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [65, "IssueTrackerBindings"],
        [66, "IssueTrackerBindingHost"],
        [67, "IssueTrackerAccounts"],
        [68, "IssueAccountStorage"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations
        WHERE migration_id <= 64 ORDER BY migration_id`,
        released,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and history on a ledger write failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedIssuePreview(66);
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      yield* sql`CREATE TRIGGER fail_issue_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'CanonicalizeThreadPullRequestLinks'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      yield* sql`DROP TRIGGER fail_issue_upgrade`;
      assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("wraps an invalid legacy PR link and rolls back schema and history before retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedIssuePreview(66);
      const payload = JSON.stringify({ linkedPullRequest: { url: "invalid" }, issues: [] });
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json)
        VALUES ('thread', 'project', 'Thread', 'codex', 'full-access', 'default',
          '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', ${payload})`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      const result = yield* runMigrations().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "MigrationError");
        if (result.failure._tag === "MigrationError") {
          assert.equal(result.failure.kind, "Failed");
        }
      }
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      assert.deepStrictEqual(
        yield* sql`SELECT payload_json FROM orchestration_v2_projection_threads`,
        [{ payload_json: payload }],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}'`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["later", "renamed", "gap"])(
    "rejects %s preview history without changing data or history",
    (invalidHistory) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedIssuePreview(66);
        if (invalidHistory === "later") {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (67, 'UnknownFork')`;
        } else if (invalidHistory === "renamed") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = 64`;
        } else {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 64`;
        }
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
        const result = yield* runMigrations().pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(
            result.failure.message,
            "Cannot upgrade Issues preview with unexpected later migrations",
          );
        }
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
          schema,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "IssueTrackerBindings"],
        [66, "IssueTrackerBindingHost"],
        [67, "IssueTrackerAccounts"],
        [68, "IssueAccountStorage"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "IssueTrackerBindings"],
        [66, "IssueTrackerBindingHost"],
        [67, "IssueTrackerAccounts"],
        [68, "IssueAccountStorage"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
