import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pull_request_links_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_request_links_json TEXT NOT NULL DEFAULT '[]'
    `;
    yield* sql`
      UPDATE projection_threads
      SET pull_request_links_json = CASE
        WHEN linked_pull_request_json IS NOT NULL AND branch_pull_request_json IS NOT NULL
          THEN json_array(
            json(json_set(linked_pull_request_json, '$.source', 'linked')),
            json(json_set(branch_pull_request_json, '$.source', 'branch'))
          )
        WHEN linked_pull_request_json IS NOT NULL
          THEN json_array(json(json_set(linked_pull_request_json, '$.source', 'linked')))
        WHEN branch_pull_request_json IS NOT NULL
          THEN json_array(json(json_set(branch_pull_request_json, '$.source', 'branch')))
        ELSE '[]'
      END
    `;
  }
});
