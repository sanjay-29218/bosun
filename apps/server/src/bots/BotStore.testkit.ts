import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A bot row for tests that need one to exist; a fresh database has none. */
export const insertTestBot = (id: string, name: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        INSERT INTO bots (
          id, name, avatar_json, color, instructions, withheld_tools_json, runtime_mode,
          model_selection_json, position, revision, created_at, updated_at
        ) VALUES (
          ${id}, ${name},
          '{"head":"round","eyes":"round","face":"visor","top":"ball","cheeks":false,"smile":false}',
          'blue', 'Coordinate.', '["crew.workflows"]', 'full-access', NULL, 0, 1, '2026-11-05', '2026-11-05'
        )
      `,
    ),
    Effect.asVoid,
  );
