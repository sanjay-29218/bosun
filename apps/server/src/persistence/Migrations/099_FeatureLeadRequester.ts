import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A feature's lead thread names the thread that started it, so that thread's Lineage lists it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('features', 'orchestration_v2_projection_threads')
  `;
  if (tables.length < 2) return;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(
      payload_json,
      '$.feature.requesterThreadId',
      (SELECT requester_thread_id FROM features
        WHERE features.id = json_extract(payload_json, '$.feature.id'))
    )
    WHERE json_extract(payload_json, '$.feature.id') IN (
        SELECT id FROM features WHERE requester_thread_id IS NOT NULL
      )
      AND json_extract(payload_json, '$.feature.member') IS NULL
      AND coalesce(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
  `;
});
