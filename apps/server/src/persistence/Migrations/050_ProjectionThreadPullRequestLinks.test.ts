import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionThreadPullRequestLinks", (it) => {
  it.effect("backfills linked and branch pull request entries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          linked_pull_request_json, branch_pull_request_json, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at
        ) VALUES (
          'thread-pr-links', 'project-pr-links', 'PR links',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":42,"url":"https://github.com/pingdotgg/t3code/pull/42"}',
          '{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":43,"url":"https://github.com/pingdotgg/t3code/pull/43"}',
          0, 0, 0, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          linked_pull_request_json, branch_pull_request_json, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at
        ) VALUES
          (
            'thread-linked-only', 'project-pr-links', 'Linked only',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            '{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":42,"url":"https://github.com/pingdotgg/t3code/pull/42"}',
            NULL, 0, 0, 0, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
          ),
          (
            'thread-branch-only', 'project-pr-links', 'Branch only',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            NULL,
            '{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":43,"url":"https://github.com/pingdotgg/t3code/pull/43"}',
            0, 0, 0, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
          ),
          (
            'thread-no-links', 'project-pr-links', 'No links',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            NULL, NULL, 0, 0, 0, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly links: string }>`
        SELECT pull_request_links_json AS links
        FROM projection_threads
        WHERE thread_id = 'thread-pr-links'
      `;
      assert.strictEqual(
        rows[0]!.links,
        '[{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":42,"url":"https://github.com/pingdotgg/t3code/pull/42","source":"linked"},{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":43,"url":"https://github.com/pingdotgg/t3code/pull/43","source":"branch"}]',
      );
      const variants = yield* sql<{ readonly threadId: string; readonly links: string }>`
        SELECT thread_id AS "threadId", pull_request_links_json AS links
        FROM projection_threads
        WHERE thread_id != 'thread-pr-links'
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(variants, [
        {
          threadId: "thread-branch-only",
          links:
            '[{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":43,"url":"https://github.com/pingdotgg/t3code/pull/43","source":"branch"}]',
        },
        {
          threadId: "thread-linked-only",
          links:
            '[{"projectId":"project-pr-links","repository":"pingdotgg/t3code","number":42,"url":"https://github.com/pingdotgg/t3code/pull/42","source":"linked"}]',
        },
        { threadId: "thread-no-links", links: "[]" },
      ]);
    }),
  );
});
