import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("tags existing feature leads with the thread that started them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(98);
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at, requester_thread_id)
      VALUES ('started', 'web', 'Started', 'Brief', '2026-11-01', 'hq'),
        ('unclaimed', 'web', 'Unclaimed', 'Brief', '2026-11-01', NULL)
    `;
    const thread = (id: string, feature: object, relationshipToParent: string | null) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${id}, 'web', ${id}, 'codex', 'full-access', 'default', '2026-11-01', '2026-11-01',
        ${JSON.stringify({ id, feature, lineage: { parentThreadId: null, relationshipToParent } })}
      )
    `;
    yield* thread("lead", { id: "started", title: "Started" }, null);
    yield* thread("crew", { id: "started", title: "Started", member: "Builder" }, "subagent");
    yield* thread("fork", { id: "started", title: "Started" }, "fork");
    yield* thread("other-lead", { id: "unclaimed", title: "Unclaimed" }, null);

    yield* BosunMigrations.runMigrations(99);

    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id AS threadId,
          json_extract(payload_json, '$.feature.requesterThreadId') AS requester
        FROM orchestration_v2_projection_threads ORDER BY thread_id
      `,
      [
        { threadId: "crew", requester: null },
        { threadId: "fork", requester: null },
        { threadId: "lead", requester: "hq" },
        { threadId: "other-lead", requester: null },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
