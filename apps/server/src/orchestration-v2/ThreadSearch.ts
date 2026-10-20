import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
  cursor: Schema.Int,
  projectId: Schema.NullOr(ProjectId),
  archived: Schema.String,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit, cursor, projectId, archived }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND (${archived} = 'include' OR
            (${archived} = 'only' AND threads.archived_at IS NOT NULL) OR
            (${archived} = 'exclude' AND threads.archived_at IS NULL))
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
        UNION ALL
        SELECT threads.thread_id, threads.project_id, 'title', threads.title, NULL,
          threads.thread_id, threads.updated_at
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL AND projects.deleted_at IS NULL
          AND (${archived} = 'include' OR
            (${archived} = 'only' AND threads.archived_at IS NOT NULL) OR
            (${archived} = 'exclude' AND threads.archived_at IS NULL))
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND threads.title LIKE ${pattern} ESCAPE '!'
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
      OFFSET ${cursor}
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      // The scan reads every message, so run it on the reader worker rather
      // than the event loop.
      const rows = yield* sql
        .withTransaction(
          searchRows({
            pattern: `%${escapeLikePattern(input.query)}%`,
            limit: (input.limit ?? 50) + 1,
            cursor: input.cursor ?? 0,
            projectId: input.projectId ?? null,
            archived: input.archived ?? "exclude",
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      return {
        nextCursor:
          rows.length > (input.limit ?? 50) ? (input.cursor ?? 0) + (input.limit ?? 50) : null,
        matches: rows.slice(0, input.limit ?? 50).map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
