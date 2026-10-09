import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Features from "./062_Features.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Workflow-only databases reached slot 64 without Feature's slot 62.
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'features'
  `;
  if (tables.length === 0) yield* Features;
});
