import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Each project's `bot-builder:` member went unused once features got crews of their own. Its
 * grants and hierarchy go, and so does the member, except where a retired handoff still names it
 * (`crew_handoffs.target_member_id` is a foreign key): that one stays, turned off, as history.
 * The Feature manager's stock context stops naming it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  if (!tables.has("crew_members")) return;
  if (tables.has("crew_delegation_grants")) {
    yield* sql`
      DELETE FROM crew_delegation_grants
      WHERE source_member_id LIKE 'bot-builder:%' OR target_member_id LIKE 'bot-builder:%'
    `;
  }
  if (tables.has("crew_hierarchy")) {
    yield* sql`UPDATE crew_hierarchy SET parent_member_id = NULL WHERE parent_member_id LIKE 'bot-builder:%'`;
    yield* sql`DELETE FROM crew_hierarchy WHERE member_id LIKE 'bot-builder:%'`;
  }
  const kept = tables.has("crew_handoffs")
    ? sql`AND id NOT IN (SELECT target_member_id FROM crew_handoffs)`
    : sql``;
  yield* sql`DELETE FROM crew_members WHERE id LIKE 'bot-builder:%' ${kept}`;
  yield* sql`UPDATE crew_members SET enabled = 0 WHERE id LIKE 'bot-builder:%'`;
  yield* sql`
    UPDATE crew_members
    SET instructions = replace(
      instructions, ' Its builder is crew member bot-builder:' || project_id || '.', ''
    )
    WHERE id LIKE 'bot-manager:%'
  `;
});
