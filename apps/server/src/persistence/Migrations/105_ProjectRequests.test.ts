import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("stores project requests once per sender's key, and features name theirs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(105);
    yield* BosunMigrations.runMigrations(105);
    const request = (project: string, number: number, key: string) => sql`
      INSERT INTO project_requests (
        project_id, number, id, requester_thread_id, send_key, text, created_at
      ) VALUES (${project}, ${number}, ${`R-${number}`}, 'hq', ${key}, 'Do it', '2026-11-05')
    `;
    yield* request("web", 1, "a");
    // Each project counts its own requests.
    yield* request("api", 1, "b");
    assert.strictEqual((yield* Effect.result(request("web", 2, "a")))._tag, "Failure");
    assert.strictEqual((yield* Effect.result(request("web", 1, "c")))._tag, "Failure");
    const [row] = yield* sql<{ readonly status: string; readonly deliveredAt: string | null }>`
      SELECT status, delivered_at AS deliveredAt FROM project_requests WHERE project_id = 'web'
    `;
    assert.deepStrictEqual(row, { status: "open", deliveredAt: null });
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('features')
    `;
    assert.isTrue(columns.some((column) => column.name === "request_id"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
