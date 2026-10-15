import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "adds execution ownership without changing existing feature identities or assignments",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`INSERT INTO features(id, project_id, title, brief, created_at, updated_at, status, bot_assignments_json) VALUES ('feature', 'project', 'Existing', 'Keep the objective', '2026-09-30', '2026-09-30', 'closed', '{"custom":"custom-bot"}')`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT title, brief, status, bot_assignments_json, owner_id FROM features`,
        [
          {
            title: "Existing",
            brief: "Keep the objective",
            status: "closed",
            bot_assignments_json: '{"custom":"custom-bot"}',
            owner_id: null,
          },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM feature_checkouts`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
