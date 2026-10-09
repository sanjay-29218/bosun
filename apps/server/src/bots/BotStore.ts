import {
  BOT_DISPATCH_STATE,
  BOT_TURN_STATE,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type BotDispatchState,
  type BotTurnState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface BotDefinition {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly featureId: string | null;
  readonly templateId: string | null;
  readonly templateRevision: number | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotTemplate {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly enabled: boolean;
  readonly autoCreateForFeature: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotHierarchyNode {
  readonly botId: string;
  readonly parentBotId: string | null;
  readonly position: number;
}

export interface BotDelegationGrant {
  readonly sourceBotId: string;
  readonly targetBotId: string;
}

export interface BotRun {
  readonly id: string;
  readonly botId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly taskText: string;
  readonly title: string;
  readonly instructions: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly botRevision: number;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly dispatchState: BotDispatchState;
  readonly recoveryAttempt: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
}

export interface BotRunSummary {
  readonly id: string;
  readonly botId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly dispatchState: BotDispatchState;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly turnState: BotTurnState;
}

interface BotDefinitionRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly featureId: string | null;
  readonly templateId: string | null;
  readonly templateRevision: number | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedToolsJson: string;
  readonly modelSelectionJson: string;
  readonly runtimeMode: string;
  readonly enabled: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BotTemplateRow {
  readonly id: string;
  readonly projectId: string | null;
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
}

interface BotRunRow {
  readonly id: string;
  readonly botId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly taskText: string;
  readonly title: string;
  readonly instructions: string;
  readonly allowedToolsJson: string;
  readonly botRevision: number;
  readonly modelSelectionJson: string;
  readonly runtimeMode: string;
  readonly dispatchState: string;
  readonly recoveryAttempt: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
}

const parseModelSelection = Schema.decodeUnknownSync(ModelSelection);
const parseRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const parseAllowedTools = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeModelSelection = (json: string) => parseModelSelection(JSON.parse(json));
const decodeAllowedTools = (json: string) => parseAllowedTools(JSON.parse(json));

const decodeDefinition = (row: BotDefinitionRow): BotDefinition => ({
  id: row.id,
  projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
  featureId: row.featureId,
  templateId: row.templateId,
  templateRevision: row.templateRevision,
  name: row.name,
  instructions: row.instructions,
  allowedTools: decodeAllowedTools(row.allowedToolsJson),
  modelSelection: decodeModelSelection(row.modelSelectionJson),
  runtimeMode: parseRuntimeMode(row.runtimeMode),
  enabled: row.enabled === 1,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const decodeTemplate = (row: BotTemplateRow): BotTemplate => ({
  id: row.id,
  projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
  name: row.name,
  instructions: row.instructions,
  allowedTools: decodeAllowedTools(row.allowedToolsJson),
  modelSelection: decodeModelSelection(row.modelSelectionJson),
  runtimeMode: parseRuntimeMode(row.runtimeMode),
  enabled: row.enabled === 1,
  autoCreateForFeature: row.autoCreateForFeature === 1,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const decodeRun = (row: BotRunRow): BotRun => ({
  id: row.id,
  botId: row.botId,
  projectId: ProjectId.make(row.projectId),
  threadId: ThreadId.make(row.threadId),
  taskText: row.taskText,
  title: row.title,
  instructions: row.instructions,
  allowedTools: decodeAllowedTools(row.allowedToolsJson),
  botRevision: row.botRevision,
  modelSelection: decodeModelSelection(row.modelSelectionJson),
  runtimeMode: parseRuntimeMode(row.runtimeMode),
  dispatchState:
    row.dispatchState === BOT_DISPATCH_STATE.STARTED
      ? BOT_DISPATCH_STATE.STARTED
      : BOT_DISPATCH_STATE.QUEUED,
  recoveryAttempt: row.recoveryAttempt,
  lastError: row.lastError,
  createdAt: row.createdAt,
  dispatchedAt: row.dispatchedAt,
});

export interface BotStoreShape {
  readonly insertTemplate: (template: BotTemplate) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateTemplate: (
    template: BotTemplate,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getTemplate: (id: string) => Effect.Effect<BotTemplate | null, PersistenceSqlError>;
  readonly listTemplatesForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotTemplate>, PersistenceSqlError>;
  readonly insertDefinition: (
    definition: BotDefinition,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getDefinition: (id: string) => Effect.Effect<BotDefinition | null, PersistenceSqlError>;
  readonly listDefinitionsForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotDefinition>, PersistenceSqlError>;
  readonly grantDelegation: (
    sourceBotId: string,
    targetBotId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly canDelegate: (
    sourceBotId: string,
    targetBotId: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly listDelegationGrantsForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotDelegationGrant>, PersistenceSqlError>;
  readonly revokeDelegation: (
    sourceBotId: string,
    targetBotId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listHierarchyForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotHierarchyNode>, PersistenceSqlError>;
  readonly setParent: (
    botId: string,
    parentBotId: string | null,
    position: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly insertRun: (run: BotRun) => Effect.Effect<void, PersistenceSqlError>;
  readonly getRun: (id: string) => Effect.Effect<BotRun | null, PersistenceSqlError>;
  readonly listQueuedRuns: () => Effect.Effect<ReadonlyArray<BotRun>, PersistenceSqlError>;
  readonly listRunSummaries: (
    projectId: ProjectId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BotRunSummary>, PersistenceSqlError>;
  readonly markStarted: (
    id: string,
    dispatchedAt: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly nextRecoveryAttempt: (id: string) => Effect.Effect<number, PersistenceSqlError>;
  readonly markDispatchError: (
    id: string,
    error: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class BotStore extends Context.Service<BotStore, BotStoreShape>()("t3/bots/BotStore") {}

export const BotStoreLive = Layer.effect(
  BotStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queryError = toPersistenceSqlError("BotStore.query");
    const decodeError = toPersistenceSqlError("BotStore.decode");

    const getDefinition = (id: string) =>
      sql<BotDefinitionRow>`
        SELECT id, project_id AS projectId, feature_id AS featureId,
          template_id AS templateId, template_revision AS templateRevision, name, instructions,
          allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          enabled,
          revision, created_at AS createdAt, updated_at AS updatedAt
        FROM bots WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeDefinition(rows[0]) : null),
            catch: decodeError,
          }),
        ),
      );

    const getTemplate = (id: string) =>
      sql<BotTemplateRow>`
        SELECT id, project_id AS projectId, name, instructions,
          allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          enabled, auto_create_for_feature AS autoCreateForFeature,
          revision, created_at AS createdAt, updated_at AS updatedAt
        FROM bot_templates WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeTemplate(rows[0]) : null), catch: decodeError }),
        ),
      );

    const getRun = (id: string) =>
      sql<BotRunRow>`
        SELECT id, bot_id AS botId, project_id AS projectId, thread_id AS threadId,
          task_text AS taskText, title, instructions,
          allowed_tools_json AS allowedToolsJson, bot_revision AS botRevision,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          dispatch_state AS dispatchState, recovery_attempt AS recoveryAttempt,
          last_error AS lastError,
          created_at AS createdAt, dispatched_at AS dispatchedAt
        FROM bot_runs WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeRun(rows[0]) : null), catch: decodeError }),
        ),
      );

    return {
      insertTemplate: (template) =>
        sql`
          INSERT INTO bot_templates (
            id, project_id, name, instructions, allowed_tools_json,
            model_selection_json, runtime_mode, enabled, auto_create_for_feature,
            revision, created_at, updated_at
          ) VALUES (
            ${template.id}, ${template.projectId}, ${template.name}, ${template.instructions},
            ${JSON.stringify(template.allowedTools)}, ${JSON.stringify(template.modelSelection)},
            ${template.runtimeMode}, ${template.enabled ? 1 : 0},
            ${template.autoCreateForFeature ? 1 : 0}, ${template.revision},
            ${template.createdAt}, ${template.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      updateTemplate: (template, expectedRevision) =>
        sql<{ readonly id: string }>`
          UPDATE bot_templates SET
            name = ${template.name}, instructions = ${template.instructions},
            allowed_tools_json = ${JSON.stringify(template.allowedTools)},
            model_selection_json = ${JSON.stringify(template.modelSelection)},
            runtime_mode = ${template.runtimeMode}, enabled = ${template.enabled ? 1 : 0},
            auto_create_for_feature = ${template.autoCreateForFeature ? 1 : 0},
            revision = ${template.revision}, updated_at = ${template.updatedAt}
          WHERE id = ${template.id} AND revision = ${expectedRevision}
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      getTemplate,
      listTemplatesForProject: (projectId) =>
        sql<BotTemplateRow>`
          SELECT id, project_id AS projectId, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled, auto_create_for_feature AS autoCreateForFeature,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM bot_templates WHERE project_id = ${projectId} OR project_id IS NULL
          ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeTemplate), catch: decodeError }),
          ),
        ),
      insertDefinition: (definition) =>
        sql`
          INSERT INTO bots (
            id, project_id, feature_id, template_id, template_revision, name, instructions,
            allowed_tools_json, model_selection_json, runtime_mode, enabled,
            revision, created_at, updated_at
          ) VALUES (
            ${definition.id}, ${definition.projectId}, ${definition.featureId},
            ${definition.templateId}, ${definition.templateRevision}, ${definition.name},
            ${definition.instructions}, ${JSON.stringify(definition.allowedTools)},
            ${JSON.stringify(definition.modelSelection)},
            ${definition.runtimeMode}, ${definition.enabled ? 1 : 0},
            ${definition.revision},
            ${definition.createdAt}, ${definition.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getDefinition,
      listDefinitionsForProject: (projectId) =>
        sql<BotDefinitionRow>`
          SELECT id, project_id AS projectId, feature_id AS featureId,
            template_id AS templateId, template_revision AS templateRevision, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM bots
          WHERE project_id = ${projectId} OR project_id IS NULL
          ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeDefinition), catch: decodeError }),
          ),
        ),
      grantDelegation: (sourceBotId, targetBotId) =>
        sql`
          INSERT OR IGNORE INTO bot_delegation_grants (source_bot_id, target_bot_id)
          VALUES (${sourceBotId}, ${targetBotId})
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      canDelegate: (sourceBotId, targetBotId) =>
        sql<{ readonly allowed: number }>`
          SELECT 1 AS allowed FROM bot_delegation_grants
          WHERE source_bot_id = ${sourceBotId} AND target_bot_id = ${targetBotId}
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      listDelegationGrantsForProject: (projectId) =>
        sql<BotDelegationGrant>`
          SELECT g.source_bot_id AS sourceBotId, g.target_bot_id AS targetBotId
          FROM bot_delegation_grants AS g JOIN bots AS target ON target.id = g.target_bot_id
          WHERE target.project_id = ${projectId}
          ORDER BY g.source_bot_id, g.target_bot_id
        `.pipe(Effect.mapError(queryError)),
      revokeDelegation: (sourceBotId, targetBotId) =>
        sql`
          DELETE FROM bot_delegation_grants
          WHERE source_bot_id = ${sourceBotId} AND target_bot_id = ${targetBotId}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      listHierarchyForProject: (projectId) =>
        sql<BotHierarchyNode>`
          SELECT h.bot_id AS botId, h.parent_bot_id AS parentBotId, h.position
          FROM bot_hierarchy AS h JOIN bots AS b ON b.id = h.bot_id
          WHERE b.project_id = ${projectId} OR b.project_id IS NULL
          ORDER BY h.parent_bot_id, h.position, h.bot_id
        `.pipe(Effect.mapError(queryError)),
      setParent: (botId, parentBotId, position) =>
        sql<{ readonly botId: string }>`
          WITH RECURSIVE ancestors(bot_id, parent_bot_id) AS (
            SELECT bot_id, parent_bot_id FROM bot_hierarchy WHERE bot_id = ${parentBotId}
            UNION ALL
            SELECT h.bot_id, h.parent_bot_id FROM bot_hierarchy AS h
            JOIN ancestors AS a ON h.bot_id = a.parent_bot_id
          )
          UPDATE bot_hierarchy
          SET parent_bot_id = ${parentBotId}, position = ${position}
          WHERE bot_id = ${botId}
            AND NOT EXISTS (SELECT 1 FROM ancestors WHERE bot_id = ${botId})
          RETURNING bot_id AS botId
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      insertRun: (run) =>
        sql`
          INSERT OR IGNORE INTO bot_runs (
            id, bot_id, project_id, thread_id, task_text, title, instructions,
            allowed_tools_json, bot_revision,
            model_selection_json, runtime_mode, dispatch_state, recovery_attempt, last_error,
            created_at, dispatched_at
          ) VALUES (
            ${run.id}, ${run.botId}, ${run.projectId}, ${run.threadId}, ${run.taskText},
            ${run.title}, ${run.instructions}, ${JSON.stringify(run.allowedTools)},
            ${run.botRevision}, ${JSON.stringify(run.modelSelection)},
            ${run.runtimeMode}, ${run.dispatchState}, ${run.recoveryAttempt}, ${run.lastError}, ${run.createdAt},
            ${run.dispatchedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getRun,
      listQueuedRuns: () =>
        sql<BotRunRow>`
          SELECT id, bot_id AS botId, project_id AS projectId, thread_id AS threadId,
            task_text AS taskText, title, instructions,
            allowed_tools_json AS allowedToolsJson, bot_revision AS botRevision,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            dispatch_state AS dispatchState, recovery_attempt AS recoveryAttempt,
            last_error AS lastError,
            created_at AS createdAt, dispatched_at AS dispatchedAt
          FROM bot_runs AS r WHERE dispatch_state = ${BOT_DISPATCH_STATE.QUEUED}
            AND NOT EXISTS (
              SELECT 1 FROM bot_handoffs AS h
              WHERE h.target_run_id = r.id AND h.status IN ('cancelled', 'failed')
            )
          ORDER BY created_at, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeRun), catch: decodeError }),
          ),
        ),
      listRunSummaries: (projectId, limit) =>
        sql<{
          readonly id: string;
          readonly botId: string;
          readonly projectId: string;
          readonly threadId: string;
          readonly dispatchState: BotDispatchState;
          readonly lastError: string | null;
          readonly createdAt: string;
          readonly turnState: BotRunSummary["turnState"];
        }>`
          SELECT id, bot_id AS botId, project_id AS projectId, thread_id AS threadId,
            dispatch_state AS dispatchState, last_error AS lastError, created_at AS createdAt,
            COALESCE((
              SELECT CASE t.status
                WHEN 'running' THEN 'running' WHEN 'waiting' THEN 'running'
                WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'error'
                WHEN 'interrupted' THEN 'interrupted' WHEN 'cancelled' THEN 'interrupted'
                WHEN 'rolled_back' THEN 'interrupted' ELSE 'pending' END
              FROM orchestration_v2_projection_runs AS t
              WHERE t.thread_id = r.thread_id ORDER BY t.ordinal DESC LIMIT 1
            ), (
              SELECT CASE legacy.state WHEN 'completed' THEN 'completed'
                WHEN 'error' THEN 'error' ELSE 'interrupted' END
              FROM projection_turns AS legacy WHERE legacy.thread_id = r.thread_id
              ORDER BY legacy.requested_at DESC, legacy.row_id DESC LIMIT 1
            ), ${BOT_TURN_STATE.MISSING}) AS turnState
          FROM bot_runs AS r WHERE project_id = ${projectId}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}
        `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) =>
            rows.map((row) => ({
              ...row,
              projectId: ProjectId.make(row.projectId),
              threadId: ThreadId.make(row.threadId),
            })),
          ),
        ),
      markStarted: (id, dispatchedAt) =>
        sql`
          UPDATE bot_runs SET dispatch_state = ${BOT_DISPATCH_STATE.STARTED},
            last_error = NULL, dispatched_at = ${dispatchedAt}
          WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      nextRecoveryAttempt: (id) =>
        sql<{ readonly recoveryAttempt: number }>`
          UPDATE bot_runs SET recovery_attempt = recovery_attempt + 1
          WHERE id = ${id} RETURNING recovery_attempt AS recoveryAttempt
        `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => rows[0]?.recoveryAttempt ?? 0),
        ),
      markDispatchError: (id, error) =>
        sql`
          UPDATE bot_runs SET last_error = ${error} WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
    } satisfies BotStoreShape;
  }),
);
