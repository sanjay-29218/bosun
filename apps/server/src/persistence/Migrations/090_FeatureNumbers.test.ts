import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("numbers each project's features in the order they were created", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(89);
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at)
      VALUES ('b', 'web', 'B', 'B', '2026-10-02'), ('a', 'web', 'A', 'A', '2026-10-01'),
        ('c', 'web', 'C', 'C', '2026-10-02'), ('x', 'api', 'X', 'X', '2026-10-03')
    `;
    yield* BosunMigrations.runMigrations(90);
    assert.deepStrictEqual(
      yield* sql`SELECT id, number FROM features ORDER BY project_id, number`,
      [
        { id: "x", number: 1 },
        { id: "a", number: 1 },
        { id: "b", number: 2 },
        { id: "c", number: 3 },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
