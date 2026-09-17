import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN failover_json TEXT`;
  yield* sql`CREATE UNIQUE INDEX idx_scheduled_tasks_failover_group
    ON scheduled_tasks(json_extract(failover_json, '$.groupId')) WHERE failover_json IS NOT NULL`;
});
