import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("preserves brief messages from an earlier local attachment build", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(91);
    yield* sql`ALTER TABLE features ADD COLUMN brief_message_json TEXT`;
    yield* sql`ALTER TABLE crew_runs ADD COLUMN opening_message_json TEXT`;
    yield* sql`INSERT INTO features (id, project_id, title, brief, created_at, brief_message_json)
      VALUES ('brief', 'project', 'Brief', 'Keep it', '2026-11-02', '{"attachments":[]}')`;

    yield* BosunMigrations.runMigrations();

    assert.deepStrictEqual(
      yield* sql`SELECT brief_message_json AS message, brief_request_hash AS requestHash FROM features WHERE id = 'brief'`,
      [{ message: '{"attachments":[]}', requestHash: null }],
    );
    yield* BosunMigrations.runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM bosun_sql_migrations WHERE migration_id = 92`,
      [{ name: "FeatureOpeningMessages" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
