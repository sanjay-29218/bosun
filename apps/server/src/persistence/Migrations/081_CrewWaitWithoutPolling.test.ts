import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const MANAGER =
  "You manage one project. Delegate implementation to the project's builder using crew_delegate and a stable request ID. Use crew_wait_handoff for its structured outcome. Report the outcome to whoever asked through crew_respond.";

it.effect("stops Captain and project managers polling, keeping the rest of their text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(80);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '["crew.delegate"]',
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 0, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:project-manager", MANAGER);
    yield* role("role:planner", "Use crew_wait_handoff for its structured outcome.");
    yield* sql`
      INSERT INTO crew_members (
        id, project_id, role_id, name, instructions, allowed_tools_json, model_selection_json,
        runtime_mode, created_at, updated_at
      ) VALUES ('bot-manager:p1', 'p1', 'role:project-manager', 'Project manager',
        ${`${MANAGER}\n\nYou manage project p1.`}, '["crew.delegate"]', '{"instanceId":"codex","model":"gpt-5"}', 'auto',
        '2026-10-01', '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(81);

    const text = (table: "bots" | "roles" | "crew_members", id: string) =>
      sql<{ readonly text: string }>`
        SELECT instructions AS text FROM ${sql(table)} WHERE id = ${id}
      `.pipe(Effect.map((rows) => rows[0]!.text));
    const captain = yield* text("bots", "bot-captain");
    const managerRole = yield* text("roles", "role:project-manager");
    const member = yield* text("crew_members", "bot-manager:p1");
    for (const prompt of [captain, managerRole, member]) {
      assert.include(prompt, "end your turn");
      assert.notInclude(prompt, "Use crew_wait_handoff");
    }
    assert.include(captain, "Relay that outcome clearly to the person.");
    assert.include(member, "Report the outcome to whoever asked");
    assert.include(member, "You manage project p1.");
    // Another role's text is its own, even with the same words.
    assert.strictEqual(
      yield* text("roles", "role:planner"),
      "Use crew_wait_handoff for its structured outcome.",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
