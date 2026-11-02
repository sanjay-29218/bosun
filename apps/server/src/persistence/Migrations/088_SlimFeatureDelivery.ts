import * as NodeUtil from "node:util";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Feature delivery becomes Plan, Design, Build and QA: QA sends changes straight back to Build,
 * and Review and the manager's change review go. Only a library copy still on the stock steps
 * moves; an edited one, and every feature's own copy, stay as they are.
 */

const ID = "feature-delivery";

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
    next: { built: "qa", design_change_requested: "change_review" },
  },
  qa: {
    type: "task",
    role: "qa",
    task: "Test the feature",
    next: { passed: "review", changes_requested: "change_review" },
    outputs: ["qa-report.md"],
  },
  review: {
    type: "task",
    role: "reviewer",
    task: "Review the feature",
    next: { approved: "end", changes_requested: "change_review" },
    limits: { changes_requested: 3 },
  },
  change_review: {
    type: "task",
    role: "manager",
    task: "Decide how to handle the requested change",
    next: { revise_design: "design", revise_build: "build" },
  },
  end: { type: "end" },
};

const SLIM_STEPS = {
  plan: STOCK_STEPS.plan,
  design: STOCK_STEPS.design,
  build: { ...STOCK_STEPS.build, next: { built: "qa", design_change_requested: "design" } },
  qa: {
    type: "task",
    role: "qa",
    task: "Test the feature",
    next: { passed: "end", changes_requested: "build" },
    limits: { changes_requested: 2 },
    outputs: ["qa-report.md"],
  },
  end: STOCK_STEPS.end,
};

const Entries = Schema.Record(Schema.String, Schema.Unknown);
const DefinitionJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      steps: Schema.Unknown,
      roles: Entries,
      layout: Schema.optionalKey(Entries),
    }),
    [Entries],
  ),
);
const decodeDefinition = Schema.decodeEffect(DefinitionJson);
const encodeDefinition = Schema.encodeEffect(DefinitionJson);

const pick = (record: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => keys.includes(key)));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_definition_heads'
  `;
  if (table === undefined) return;
  const [head] = yield* sql<{ readonly revision: number; readonly json: string }>`
    SELECT h.revision, r.definition_json AS json
    FROM workflow_definition_heads AS h
    JOIN workflow_definition_revisions AS r ON r.id = h.id AND r.revision = h.revision
    WHERE h.id = ${ID}
  `;
  if (head === undefined) return;
  const definition = yield* decodeDefinition(head.json);
  if (!NodeUtil.isDeepStrictEqual(definition.steps, STOCK_STEPS)) return;

  const steps = Object.keys(SLIM_STEPS);
  const { layout, ...rest } = definition;
  const revision = head.revision + 1;
  const slim = {
    ...rest,
    revision,
    roles: pick(definition.roles, ["manager", "planner", "designer", "builder", "qa"]),
    steps: SLIM_STEPS,
    ...(layout === undefined ? {} : { layout: pick(layout, steps) }),
  };
  yield* sql`
    INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
    VALUES (${ID}, ${revision}, ${yield* encodeDefinition(slim)}, ${DateTime.formatIso(yield* DateTime.now)})
  `;
  yield* sql`UPDATE workflow_definition_heads SET revision = ${revision} WHERE id = ${ID}`;
});
