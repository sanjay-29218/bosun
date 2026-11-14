import { assert, it } from "@effect/vitest";
import { grantedTools } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const TOOLKITS = ["orchestration", "worktree", "pull-requests", "preview", "device"];

/**
 * The rules before 116, written out: unreadable lists grant nothing extra; naming no toolkit is
 * every toolkit, naming some is only those; "crew.workflows" is held when listed.
 */
const oldGrants = (json: string): ReadonlyArray<string> => {
  let listed: ReadonlyArray<string> = [];
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) listed = value;
  } catch {}
  const limit = TOOLKITS.filter((toolkit) => listed.includes(toolkit));
  return [
    ...(listed.includes("crew.workflows") ? ["crew.workflows"] : []),
    ...(limit.length === 0 ? TOOLKITS : limit),
  ].toSorted();
};
const newGrants = (json: string, bot: boolean) =>
  grantedTools(JSON.parse(json) as ReadonlyArray<string>, { bot }).toSorted();

const SHAPES = {
  empty: "[]",
  everyToolkit: JSON.stringify(TOOLKITS),
  browserOnly: '["preview"]',
  manageCrew: '["crew.workflows"]',
  manageCrewAndTwo: '["crew.workflows","worktree","device"]',
  unknownIds: '["crew.decide","crew.answer","made-up"]',
  invalidJson: "not json",
  notAList: '{"preview":true}',
};

it.effect("stores withheld tools, keeping every agent's effective tools", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(115);
    const model = '{"instanceId":"codex","model":"gpt-5"}';
    for (const [shape, tools] of Object.entries(SHAPES)) {
      yield* sql`
        INSERT INTO bots (
          id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
          created_at, updated_at
        ) VALUES (${`bot-${shape}`}, ${shape}, '{}', 'blue', '', ${tools}, 'auto', 1,
          '2026-11-01', '2026-11-01')
      `;
      yield* sql`
        INSERT INTO roles (
          id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
          revision, created_at, updated_at
        ) VALUES (${`role-${shape}`}, ${shape}, '', ${tools}, ${model}, 'auto-accept-edits', 1,
          '2026-11-01', '2026-11-01')
      `;
      yield* sql`
        INSERT INTO crew_members (
          id, project_id, name, instructions, allowed_tools_json, model_selection_json,
          runtime_mode, created_at, updated_at
        ) VALUES (${`member-${shape}`}, 'web', ${shape}, '', ${tools}, ${model},
          'approval-required', '2026-11-01', '2026-11-01')
      `;
      for (const [run, memberId] of [
        [`bot-run-${shape}`, `bot-${shape}`],
        [`member-run-${shape}`, `member-${shape}`],
      ] as const) {
        yield* sql`
          INSERT INTO crew_runs (
            id, member_id, project_id, thread_id, task_text, title, instructions,
            allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at
          ) VALUES (${run}, ${memberId}, 'web', ${`bot-run:${run}`}, 'Do it.', ${run}, '',
            ${tools}, 1, ${model}, 'full-access', '2026-11-01')
        `;
      }
    }
    const builder = {
      id: "role:builder",
      name: "Builder",
      instructions: "",
      modelSelection: JSON.parse(model),
      runtimeMode: "full-access",
    };
    const role = (allowedTools: ReadonlyArray<string>) => ({ ...builder, allowedTools });
    const snapshot = {
      workflow: {
        id: "w",
        name: "W",
        instructions: "",
        leadRoleId: "role:builder",
        crewRoleIds: [],
        revision: 1,
      },
      roles: [role(["preview"]), role([])],
    };
    yield* sql`
      INSERT INTO crew_run_workflows (run_id, workflow_json)
      VALUES ('member-run-empty', ${JSON.stringify({ snapshot, here: "Mac", from: "VPS" })})
    `;
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at, updated_at, workflow_snapshot_json)
      VALUES ('feature', 'web', 'F', 'B', '2026-11-01', '2026-11-01', ${JSON.stringify(snapshot)})
    `;
    const before = new Map<string, { readonly tools: string; readonly mode: string }>();
    for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
      const rows = yield* sql<{ id: string; tools: string; mode: string }>`
        SELECT id, allowed_tools_json AS tools, runtime_mode AS mode FROM ${sql(table)}
      `;
      for (const row of rows) before.set(row.id, row);
    }

    yield* BosunMigrations.runMigrations(116);

    for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
      const rows = yield* sql<{ id: string; tools: string; mode: string }>`
        SELECT id, withheld_tools_json AS tools, runtime_mode AS mode FROM ${sql(table)}
      `;
      assert.strictEqual(rows.length, Object.keys(SHAPES).length * (table === "crew_runs" ? 2 : 1));
      for (const row of rows) {
        const old = before.get(row.id)!;
        const bot = row.id.startsWith("bot-");
        const expected = bot
          ? oldGrants(old.tools)
          : // The one change: a non-bot listing "crew.workflows" no longer holds it. Roles and
            // project managers refused it; it could only reach other members by hand.
            oldGrants(old.tools).filter((tool) => tool !== "crew.workflows");
        assert.deepStrictEqual(newGrants(row.tools, bot), expected, `${table} ${row.id}`);
        assert.strictEqual(row.mode, old.mode);
      }
    }
    assert.deepStrictEqual(
      (yield* sql<{ tools: string }>`
        SELECT withheld_tools_json AS tools FROM crew_members WHERE id = 'member-browserOnly'
      `)[0]?.tools,
      '["orchestration","worktree","pull-requests","device"]',
    );
    assert.deepStrictEqual(
      (yield* sql<{ tools: string }>`
        SELECT withheld_tools_json AS tools FROM bots WHERE id = 'bot-empty'
      `)[0]?.tools,
      '["crew.workflows"]',
    );
    // Roles a linked environment sent by value convert the same way.
    const convertedRoles = [
      { ...builder, withheldTools: ["orchestration", "worktree", "pull-requests", "device"] },
      { ...builder, withheldTools: [] },
    ];
    const [linked] = yield* sql<{
      json: string;
    }>`SELECT workflow_json AS json FROM crew_run_workflows`;
    assert.deepStrictEqual(JSON.parse(linked!.json).snapshot.roles, convertedRoles);
    const [feature] = yield* sql<{ json: string }>`
      SELECT workflow_snapshot_json AS json FROM features
    `;
    assert.deepStrictEqual(JSON.parse(feature!.json).roles, convertedRoles);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
