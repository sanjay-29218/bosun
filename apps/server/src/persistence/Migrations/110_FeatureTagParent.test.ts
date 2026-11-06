import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("tags every thread of an existing child feature with its parent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(109);
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at, parent_feature_id)
      VALUES ('epic', 'web', 'Epic', 'Brief', '2026-11-01', NULL),
        ('child', 'web', 'Child', 'Brief', '2026-11-01', 'epic')
    `;
    const thread = (id: string, feature: object) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${id}, 'web', ${id}, 'codex', 'full-access', 'default', '2026-11-01', '2026-11-01',
        ${JSON.stringify({ id, feature })}
      )
    `;
    yield* thread("epic-lead", { id: "epic", title: "Epic" });
    yield* thread("child-lead", { id: "child", title: "Child" });
    yield* thread("child-crew", { id: "child", title: "Child", member: "Builder" });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES ('plain', 'web', 'plain', 'codex', 'full-access', 'default', '2026-11-01',
        '2026-11-01', '{"id":"plain"}')
    `;

    yield* BosunMigrations.runMigrations(110);

    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id AS threadId,
          json_extract(payload_json, '$.feature.parentFeatureId') AS parent
        FROM orchestration_v2_projection_threads ORDER BY thread_id
      `,
      [
        { threadId: "child-crew", parent: "epic" },
        { threadId: "child-lead", parent: "epic" },
        { threadId: "epic-lead", parent: null },
        { threadId: "plain", parent: null },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
