import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Every thread of a child feature names its parent, so clients fold it under the parent's row. */
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
      '$.feature.parentFeatureId',
      (SELECT parent_feature_id FROM features
        WHERE features.id = json_extract(payload_json, '$.feature.id'))
    )
    WHERE json_extract(payload_json, '$.feature.id') IN (
      SELECT id FROM features WHERE parent_feature_id IS NOT NULL
    )
  `;
});
