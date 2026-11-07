import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A project's manager is set up in its project's settings, not from a Library role. Existing
 * managers keep what they have; the "Project manager" role goes (`crew_members.role_id` is a
 * foreign key, so they let go of it first).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  if (!tables.has("roles") || !tables.has("crew_members")) return;
  yield* sql`
    UPDATE crew_members SET role_id = NULL, role_revision = NULL
    WHERE role_id = 'role:project-manager'
  `;
  yield* sql`DELETE FROM roles WHERE id = 'role:project-manager'`;
});
