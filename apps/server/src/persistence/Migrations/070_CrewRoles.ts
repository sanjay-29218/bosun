import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Crew bots become Roles. Per-project bot templates merge into global roles, bot instances
 * become crew members, and workflows become one global library on schema version 2:
 * `bots` -> `roles` of `{ roleId, roleRevision, supervisor }`, step `bot` -> `role`, and the
 * `existing-project-bot` binding becomes the project manager role. Persisted JSON that names
 * the old fields (step events, executions, handoff receipts) is rewritten to match.
 */

const PROJECT_MANAGER_ROLE_ID = "role:project-manager";
const STARTER_WORKFLOW_ID = "feature-delivery";
const DEFAULT_ROLE_IDS: Readonly<Record<string, string>> = {
  manager: PROJECT_MANAGER_ROLE_ID,
  planner: "role:planner",
  designer: "role:designer",
  builder: "role:builder",
  "qa-tester": "role:qa-tester",
  reviewer: "role:reviewer",
};

/** The global role a template becomes; null for Captain, which is not a role. */
const globalRoleId = (templateId: string): string | null => {
  if (templateId === "template:captain") return null;
  const kind = /^template:([a-z-]+):/.exec(templateId)?.[1];
  return (kind === undefined ? undefined : DEFAULT_ROLE_IDS[kind]) ?? templateId;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rewrites a version 1 definition; anything else is returned untouched. */
const toVersion2 = (json: string, managerRevision: number, id?: string): string => {
  let definition: unknown;
  try {
    definition = JSON.parse(json);
  } catch {
    return json;
  }
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    !isRecord(definition.bots) ||
    !isRecord(definition.steps)
  ) {
    return json;
  }
  const { bots, steps, ...rest } = definition;
  const roles: Record<string, unknown> = {};
  for (const [slot, bot] of Object.entries(bots)) {
    if (!isRecord(bot) || !isRecord(bot.template)) return json;
    const source = bot.template;
    roles[slot] =
      source.kind === "existing-project-bot"
        ? { roleId: PROJECT_MANAGER_ROLE_ID, roleRevision: managerRevision }
        : {
            roleId: globalRoleId(String(source.id)) ?? source.id,
            roleRevision: source.revision,
          };
    (roles[slot] as Record<string, unknown>).supervisor = bot.supervisor ?? null;
  }
  const nextSteps: Record<string, unknown> = {};
  for (const [stepId, step] of Object.entries(steps)) {
    if (isRecord(step) && step.type === "task") {
      const { bot, ...task } = step;
      nextSteps[stepId] = { ...task, role: bot };
    } else {
      nextSteps[stepId] = step;
    }
  }
  return JSON.stringify({
    ...rest,
    ...(id === undefined ? {} : { id }),
    schemaVersion: 2,
    roles,
    steps: nextSteps,
  });
};

const renameJsonKey = (from: string, to: string) => (json: string) => {
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !Object.hasOwn(value, from)) return json;
    const { [from]: moved, ...rest } = value;
    return JSON.stringify({ ...rest, [to]: moved });
  } catch {
    return json;
  }
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  // Tables are rebuilt below; their rows are only consistent again at commit.
  yield* sql`PRAGMA defer_foreign_keys = ON`;

  if (tables.has("bot_templates")) {
    yield* sql`ALTER TABLE bot_templates RENAME TO roles`;
    yield* sql`ALTER TABLE roles DROP COLUMN project_id`;
  }
  if (tables.has("bots")) {
    yield* sql`DROP TRIGGER IF EXISTS bot_hierarchy_new_bot`;
    yield* sql`ALTER TABLE bots RENAME TO crew_members`;
    yield* sql`ALTER TABLE crew_members RENAME COLUMN template_id TO role_id`;
    yield* sql`ALTER TABLE crew_members RENAME COLUMN template_revision TO role_revision`;
  }
  if (tables.has("bot_runs")) {
    yield* sql`ALTER TABLE bot_runs RENAME TO crew_runs`;
    yield* sql`ALTER TABLE crew_runs RENAME COLUMN bot_id TO member_id`;
    yield* sql`ALTER TABLE crew_runs RENAME COLUMN bot_revision TO member_revision`;
    yield* sql`DROP INDEX IF EXISTS bot_runs_pending`;
    yield* sql`DROP INDEX IF EXISTS bot_runs_started`;
    yield* sql`
      CREATE INDEX crew_runs_pending ON crew_runs (created_at, id)
      WHERE dispatch_state = 'queued'
    `;
    yield* sql`CREATE INDEX crew_runs_started ON crew_runs (id) WHERE dispatch_state = 'started'`;
  }
  if (tables.has("bot_handoffs")) {
    yield* sql`ALTER TABLE bot_handoffs RENAME TO crew_handoffs`;
    yield* sql`ALTER TABLE crew_handoffs RENAME COLUMN target_bot_id TO target_member_id`;
    yield* sql`DROP INDEX IF EXISTS bot_handoffs_source`;
    yield* sql`DROP INDEX IF EXISTS bot_handoffs_pending`;
    yield* sql`CREATE INDEX crew_handoffs_source ON crew_handoffs (source_run_id, created_at)`;
    yield* sql`CREATE INDEX crew_handoffs_pending ON crew_handoffs (status, created_at)`;
  }
  if (tables.has("bot_handoff_receipts")) {
    yield* sql`ALTER TABLE bot_handoff_receipts RENAME TO crew_handoff_receipts`;
    yield* sql`DROP INDEX IF EXISTS bot_handoff_receipts_handoff`;
    yield* sql`
      CREATE INDEX crew_handoff_receipts_handoff ON crew_handoff_receipts (handoff_id, sequence)
    `;
    const rename = renameJsonKey("targetBotId", "targetMemberId");
    const receipts = yield* sql<{ readonly sequence: number; readonly json: string }>`
      SELECT sequence, handoff_json AS json FROM crew_handoff_receipts
    `;
    for (const receipt of receipts) {
      const next = rename(receipt.json);
      if (next !== receipt.json) {
        yield* sql`
          UPDATE crew_handoff_receipts SET handoff_json = ${next}
          WHERE sequence = ${receipt.sequence}
        `;
      }
    }
  }
  if (tables.has("bot_hierarchy")) {
    yield* sql`ALTER TABLE bot_hierarchy RENAME TO crew_hierarchy`;
    yield* sql`ALTER TABLE crew_hierarchy RENAME COLUMN bot_id TO member_id`;
    yield* sql`ALTER TABLE crew_hierarchy RENAME COLUMN parent_bot_id TO parent_member_id`;
    yield* sql`DROP INDEX IF EXISTS bot_hierarchy_parent`;
    yield* sql`
      CREATE INDEX crew_hierarchy_parent
      ON crew_hierarchy (parent_member_id, position, member_id)
    `;
    if (tables.has("bots")) {
      yield* sql`
        CREATE TRIGGER crew_hierarchy_new_member AFTER INSERT ON crew_members
        BEGIN
          INSERT INTO crew_hierarchy (member_id, parent_member_id) VALUES (NEW.id, NULL);
        END
      `;
    }
  }
  if (tables.has("bot_delegation_grants")) {
    yield* sql`ALTER TABLE bot_delegation_grants RENAME TO crew_delegation_grants`;
    yield* sql`
      ALTER TABLE crew_delegation_grants RENAME COLUMN source_bot_id TO source_member_id
    `;
    yield* sql`
      ALTER TABLE crew_delegation_grants RENAME COLUMN target_bot_id TO target_member_id
    `;
  }

  // Each default role keeps the most recently edited project's copy of its template.
  let managerRevision = 1;
  if (tables.has("bot_templates")) {
    const templates = yield* sql<{
      readonly id: string;
      readonly name: string;
      readonly instructions: string;
      readonly allowedToolsJson: string;
      readonly modelSelectionJson: string;
      readonly runtimeMode: string;
      readonly enabled: number;
      readonly autoCreateForFeature: number;
      readonly revision: number;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>`
      SELECT id, name, instructions, allowed_tools_json AS allowedToolsJson,
        model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode, enabled,
        auto_create_for_feature AS autoCreateForFeature, revision,
        created_at AS createdAt, updated_at AS updatedAt
      FROM roles
    `;
    const winners = new Map<string, (typeof templates)[number]>();
    for (const template of templates) {
      const roleId = globalRoleId(template.id);
      if (roleId === null || roleId === template.id) continue;
      const current = winners.get(roleId);
      if (!current || template.updatedAt > current.updatedAt) winners.set(roleId, template);
    }
    for (const [roleId, template] of winners) {
      const name =
        roleId === PROJECT_MANAGER_ROLE_ID && template.name === "Manager"
          ? "Project manager"
          : template.name;
      yield* sql`
        INSERT OR IGNORE INTO roles (
          id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
          enabled, auto_create_for_feature, revision, created_at, updated_at
        ) VALUES (
          ${roleId}, ${name}, ${template.instructions}, ${template.allowedToolsJson},
          ${template.modelSelectionJson}, ${template.runtimeMode}, ${template.enabled},
          ${template.autoCreateForFeature}, ${template.revision}, ${template.createdAt},
          ${template.updatedAt}
        )
      `;
    }
    for (const template of templates) {
      const roleId = globalRoleId(template.id);
      if (roleId === template.id) continue;
      // Members keep the revision they were made from; their feature's workflow copy pins it.
      if (roleId === null) {
        yield* sql`
          UPDATE crew_members SET role_id = NULL, role_revision = NULL
          WHERE role_id = ${template.id}
        `;
      } else {
        yield* sql`UPDATE crew_members SET role_id = ${roleId} WHERE role_id = ${template.id}`;
      }
      yield* sql`DELETE FROM roles WHERE id = ${template.id}`;
    }
    const manager = yield* sql<{ readonly revision: number }>`
      SELECT revision FROM roles WHERE id = ${PROJECT_MANAGER_ROLE_ID}
    `;
    managerRevision = manager[0]?.revision ?? 1;
  }

  // Stage tools are now crew_* tools granted as crew.*.
  if (tables.has("bot_templates")) {
    yield* sql`
      UPDATE roles SET allowed_tools_json = REPLACE(allowed_tools_json, '"bots.', '"crew.'),
        instructions = REPLACE(instructions, 'bots_', 'crew_')
    `;
  }
  if (tables.has("bots")) {
    yield* sql`
      UPDATE crew_members SET allowed_tools_json = REPLACE(allowed_tools_json, '"bots.', '"crew.'),
        instructions = REPLACE(instructions, 'bots_', 'crew_')
    `;
  }
  if (tables.has("bot_runs")) {
    yield* sql`
      UPDATE crew_runs SET allowed_tools_json = REPLACE(allowed_tools_json, '"bots.', '"crew.'),
        instructions = REPLACE(instructions, 'bots_', 'crew_')
    `;
  }

  const featureColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(features)`;
  if (featureColumns.some((column) => column.name === "bot_assignments_json")) {
    yield* sql`ALTER TABLE features RENAME COLUMN bot_assignments_json TO crew_assignments_json`;
  }

  if (tables.has("workflow_executions")) {
    const executions = yield* sql<{ readonly featureId: string; readonly json: string }>`
      SELECT feature_id AS featureId, bindings_json AS json FROM workflow_executions
    `;
    for (const execution of executions) {
      const next = renameBindings(execution.json);
      if (next !== execution.json) {
        yield* sql`
          UPDATE workflow_executions SET bindings_json = ${next}
          WHERE feature_id = ${execution.featureId}
        `;
      }
    }
  }

  if (tables.has("workflow_step_events")) {
    yield* sql`
      UPDATE workflow_step_events SET event_json = json_remove(
        json_set(event_json, '$.runId', json_extract(event_json, '$.botRunId')),
        '$.botRunId'
      )
      WHERE json_valid(event_json) AND json_type(event_json, '$.botRunId') IS NOT NULL
    `;
  }

  if (tables.has("workflow_definition_heads") && tables.has("feature_workflows")) {
    const heads = yield* sql<{
      readonly projectId: string;
      readonly id: string;
      readonly revision: number;
      readonly createdAt: string;
    }>`
      SELECT h.project_id AS projectId, h.id, h.revision, r.created_at AS createdAt
      FROM workflow_definition_heads AS h
      JOIN workflow_definition_revisions AS r
        ON r.project_id = h.project_id AND r.id = h.id AND r.revision = h.revision
      ORDER BY r.created_at DESC, h.project_id
    `;
    const revisions = yield* sql<{
      readonly projectId: string;
      readonly id: string;
      readonly revision: number;
      readonly json: string;
      readonly createdAt: string;
    }>`
      SELECT project_id AS projectId, id, revision, definition_json AS json,
        created_at AS createdAt
      FROM workflow_definition_revisions
    `;
    const copies = yield* sql<{
      readonly featureId: string;
      readonly projectId: string;
      readonly workflowId: string;
      readonly workflowRevision: number;
      readonly json: string;
      readonly createdAt: string;
      readonly eventVersion: number;
    }>`
      SELECT feature_id AS featureId, project_id AS projectId, workflow_id AS workflowId,
        workflow_revision AS workflowRevision, definition_json AS json,
        created_at AS createdAt, event_version AS eventVersion
      FROM feature_workflows
    `;

    // One library entry per ID: the most recently published project's. Other projects'
    // starter copies are dropped; any other clash keeps its history under `<id>:<project>`.
    const libraryId = new Map<string, string | null>();
    const claimed = new Set<string>();
    for (const head of heads) {
      const key = `${head.projectId}\u0000${head.id}`;
      if (!claimed.has(head.id)) {
        claimed.add(head.id);
        libraryId.set(key, head.id);
      } else {
        libraryId.set(key, head.id === STARTER_WORKFLOW_ID ? null : `${head.id}:${head.projectId}`);
      }
    }

    yield* sql`DROP TABLE feature_workflows`;
    yield* sql`DROP TABLE workflow_definition_revisions`;
    yield* sql`DROP TABLE workflow_definition_heads`;
    yield* sql`
      CREATE TABLE workflow_definition_heads (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0)
      )
    `;
    yield* sql`
      CREATE TABLE workflow_definition_revisions (
        id TEXT NOT NULL REFERENCES workflow_definition_heads(id),
        revision INTEGER NOT NULL CHECK (revision > 0),
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, revision)
      )
    `;
    // A feature runs on its own copy, so it no longer references the library's history.
    yield* sql`
      CREATE TABLE feature_workflows (
        feature_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 0 CHECK (event_version >= 0)
      )
    `;
    yield* sql`
      CREATE INDEX feature_workflows_project ON feature_workflows (project_id, created_at, feature_id)
    `;
    for (const head of heads) {
      const id = libraryId.get(`${head.projectId}\u0000${head.id}`);
      if (id) {
        yield* sql`
          INSERT INTO workflow_definition_heads (id, revision) VALUES (${id}, ${head.revision})
        `;
      }
    }
    for (const revision of revisions) {
      const id = libraryId.get(`${revision.projectId}\u0000${revision.id}`);
      if (!id) continue;
      yield* sql`
        INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
        VALUES (${id}, ${revision.revision},
          ${toVersion2(revision.json, managerRevision, id === revision.id ? undefined : id)},
          ${revision.createdAt})
      `;
    }
    for (const copy of copies) {
      const renamed = libraryId.get(`${copy.projectId}\u0000${copy.workflowId}`);
      const workflowId = renamed ?? copy.workflowId;
      yield* sql`
        INSERT INTO feature_workflows (
          feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at,
          event_version
        ) VALUES (
          ${copy.featureId}, ${copy.projectId}, ${workflowId}, ${copy.workflowRevision},
          ${toVersion2(copy.json, managerRevision, workflowId === copy.workflowId ? undefined : workflowId)},
          ${copy.createdAt}, ${copy.eventVersion}
        )
      `;
    }
  }
});

/** `{ slot: { botId, dispatchRunId } }` bindings name the crew member `memberId`. */
function renameBindings(json: string): string {
  const rename = renameJsonKey("botId", "memberId");
  try {
    const bindings: unknown = JSON.parse(json);
    if (!isRecord(bindings)) return json;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [slot, binding] of Object.entries(bindings)) {
      const encoded = JSON.stringify(binding);
      const renamed = rename(encoded);
      changed ||= renamed !== encoded;
      next[slot] = JSON.parse(renamed);
    }
    return changed ? JSON.stringify(next) : json;
  } catch {
    return json;
  }
}
