import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const setUp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 79 });
  yield* BosunMigrations.reconcileLegacyHistory();
  yield* BosunMigrations.runMigrations(113);
  return sql;
});

const botIds = (sql: SqlClient.SqlClient) =>
  sql<{ readonly id: string }>`SELECT id FROM bots ORDER BY id`.pipe(
    Effect.map((rows) => rows.map((row) => row.id)),
  );

const insertProject = (sql: SqlClient.SqlClient, id: string, botId: string) => sql`
  INSERT INTO projection_projects (
    project_id, title, workspace_root, scripts_json, created_at, updated_at, bot_id
  ) VALUES (${id}, ${id}, ${`/work/${id}`}, '[]', '2026-11-01', '2026-11-01', ${botId})
`;

it.effect("drops the seeded Captain from a database nobody has used", () =>
  Effect.gen(function* () {
    const sql = yield* setUp;
    yield* BosunMigrations.runMigrations(114);
    assert.deepStrictEqual(yield* botIds(sql), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "keeps Captain and its projects on an install in use, and allows a project with no bot",
  () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      yield* insertProject(sql, "web", "bot-captain");
      yield* BosunMigrations.runMigrations(114);
      assert.deepStrictEqual(yield* botIds(sql), ["bot-captain"]);
      yield* sql`INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES ('loose', 'loose', '/work/loose', '[]', '2026-11-01', '2026-11-01')`;
      assert.deepStrictEqual(
        yield* sql`SELECT project_id AS id, bot_id AS botId FROM projection_projects ORDER BY id`,
        [
          { id: "loose", botId: null },
          { id: "web", botId: "bot-captain" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps a Captain someone saved, even with nothing else in the database", () =>
  Effect.gen(function* () {
    const sql = yield* setUp;
    yield* sql`UPDATE bots SET revision = 2, updated_at = '2026-11-01' WHERE id = 'bot-captain'`;
    yield* BosunMigrations.runMigrations(114);
    assert.deepStrictEqual(yield* botIds(sql), ["bot-captain"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
