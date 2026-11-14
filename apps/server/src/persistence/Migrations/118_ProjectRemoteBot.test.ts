import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("keeps each project's bot here and gives none an owner elsewhere", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(117);
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, bot_id, created_at, updated_at
      ) VALUES ('project:docs', 'docs', '/code/docs', '[]', 'bot-ops', '2026-11-01', '2026-11-01')
    `;

    yield* BosunMigrations.runMigrations(118);

    const store = yield* ProjectStore.make;
    const row = Option.getOrThrow(yield* store.get(ProjectId.make("project:docs")));
    assert.strictEqual(row.botId, "bot-ops");
    assert.strictEqual(row.remoteBot, null);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
