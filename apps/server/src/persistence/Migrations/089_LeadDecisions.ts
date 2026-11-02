import * as NodeUtil from "node:util";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Crew handoffs retire: a stage asks its question with crew_respond, and a feature's lead
 * decides with crew_decide. Grants follow (crew.answer becomes crew.decide, crew.ask goes),
 * stock text that names the old tools is rewritten, and an unedited Feature delivery gets its
 * "(auto)" twin, where the lead decides. Edited text and workflows stay as they are.
 */

const OLD_STAGE_ASK =
  "If information is missing, call crew_ask with the exact question, then continue after an answer.";
const NEW_STAGE_ASK =
  'If information is missing, call crew_respond with outcome "needs_input" and the exact question as the summary, then end your turn; the answer arrives in this thread.';
const OLD_MANAGER =
  "You manage one project's features. Stage results and questions arrive in this thread as new messages. Answer a stage's question with crew_answer, or ask whoever asked you with crew_ask and pass the answer on with crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.";
const NEW_MANAGER =
  "You manage one project's features. When a feature lets its lead decide, a stage's gate or question arrives in this thread as a new message: check the stage's work, then approve, request changes or answer with crew_decide. When a workflow gives you a stage of your own, report its outcome with crew_respond. Keep the task and context bounded.";
const REWRITES: ReadonlyArray<readonly [string, string]> = [
  [OLD_STAGE_ASK, NEW_STAGE_ASK],
  [OLD_MANAGER, NEW_MANAGER],
];

const STARTER_ID = "feature-delivery";
const AUTO_ID = "feature-delivery-auto";
const STOCK_STEPS = {
  plan: {
    type: "task",
    role: "planner",
    task: "Plan the feature",
    next: { ready: "design" },
    gate: true,
    outputs: ["plan.md"],
  },
  design: {
    type: "task",
    role: "designer",
    task: "Design the feature",
    next: { ready: "build" },
    gate: true,
    outputs: ["design.md"],
  },
  build: {
    type: "task",
    role: "builder",
    task: "Build the feature",
    next: { built: "qa", design_change_requested: "design" },
  },
  qa: {
    type: "task",
    role: "qa",
    task: "Test the feature",
    next: { passed: "end", changes_requested: "build" },
    limits: { changes_requested: 2 },
    outputs: ["qa-report.md"],
  },
  end: { type: "end" },
};

const Entries = Schema.Record(Schema.String, Schema.Unknown);
const DefinitionJson = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ steps: Schema.Unknown, defaults: Entries }), [Entries]),
);
const decodeDefinition = Schema.decodeEffect(DefinitionJson);
const encodeDefinition = Schema.encodeEffect(DefinitionJson);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
    if (!(yield* hasTable(table))) continue;
    yield* sql`
      UPDATE ${sql(table)} SET allowed_tools_json = (
        SELECT json_group_array(tool) FROM (
          SELECT CASE value WHEN 'crew.answer' THEN 'crew.decide' ELSE value END AS tool,
            MIN(key) AS position
          FROM json_each(${sql(table)}.allowed_tools_json)
          WHERE value <> 'crew.ask'
          GROUP BY tool ORDER BY position
        )
      )
      WHERE json_valid(allowed_tools_json) AND EXISTS (
        SELECT 1 FROM json_each(${sql(table)}.allowed_tools_json)
        WHERE value IN ('crew.ask', 'crew.answer')
      )
    `;
    for (const [from, to] of REWRITES) {
      yield* sql`
        UPDATE ${sql(table)} SET instructions = replace(instructions, ${from}, ${to})
        WHERE instr(instructions, ${from}) > 0
      `;
    }
  }

  if (!(yield* hasTable("workflow_definition_heads"))) return;
  const [head] = yield* sql<{ readonly json: string }>`
    SELECT r.definition_json AS json
    FROM workflow_definition_heads AS h
    JOIN workflow_definition_revisions AS r ON r.id = h.id AND r.revision = h.revision
    WHERE h.id = ${STARTER_ID}
  `;
  const [taken] = yield* sql`SELECT 1 FROM workflow_definition_heads WHERE id = ${AUTO_ID}`;
  if (head === undefined || taken !== undefined) return;
  const starter = yield* decodeDefinition(head.json);
  if (!NodeUtil.isDeepStrictEqual(starter.steps, STOCK_STEPS)) return;
  const auto = {
    ...starter,
    id: AUTO_ID,
    name: "Feature delivery (auto)",
    revision: 1,
    defaults: { ...starter.defaults, decisions: "lead" },
  };
  yield* sql`INSERT INTO workflow_definition_heads (id, revision) VALUES (${AUTO_ID}, 1)`;
  yield* sql`
    INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
    VALUES (${AUTO_ID}, 1, ${yield* encodeDefinition(auto)}, ${DateTime.formatIso(yield* DateTime.now)})
  `;
});
