import { ModelSelection, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export const BotRole = Schema.Literals([
  "captain",
  "manager",
  "planner",
  "designer",
  "execution",
  "reviewer",
]);
export type BotRole = typeof BotRole.Type;

export interface BotDefinition {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly role: BotRole;
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
  readonly dispatchState: "queued" | "started";
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
  readonly dispatchState: "queued" | "started";
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly turnState: "missing" | "pending" | "running" | "completed" | "interrupted" | "error";
}

interface BotDefinitionRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly role: string;
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
const parseRole = Schema.decodeUnknownSync(BotRole);
const parseRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const parseAllowedTools = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeModelSelection = (json: string) => parseModelSelection(JSON.parse(json));
const decodeAllowedTools = (json: string) => parseAllowedTools(JSON.parse(json));

const decodeDefinition = (row: BotDefinitionRow): BotDefinition => ({
  id: row.id,
  projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
  role: parseRole(row.role),
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
  dispatchState: row.dispatchState === "started" ? "started" : "queued",
  recoveryAttempt: row.recoveryAttempt,
  lastError: row.lastError,
  createdAt: row.createdAt,
  dispatchedAt: row.dispatchedAt,
});

export interface BotStoreShape {
  readonly insertDefinition: (
    definition: BotDefinition,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getDefinition: (id: string) => Effect.Effect<BotDefinition | null, PersistenceSqlError>;
  readonly listDefinitionsForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotDefinition>, PersistenceSqlError>;
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
        SELECT id, project_id AS projectId, role, name, instructions,
          allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          enabled, revision, created_at AS createdAt, updated_at AS updatedAt
        FROM bosun_bot_definitions WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeDefinition(rows[0]) : null),
            catch: decodeError,
          }),
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
        FROM bosun_bot_runs WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeRun(rows[0]) : null), catch: decodeError }),
        ),
      );

    return {
      insertDefinition: (definition) =>
        sql`
          INSERT INTO bosun_bot_definitions (
            id, project_id, role, name, instructions, allowed_tools_json, model_selection_json,
            runtime_mode, enabled, revision, created_at, updated_at
          ) VALUES (
            ${definition.id}, ${definition.projectId}, ${definition.role}, ${definition.name},
            ${definition.instructions}, ${JSON.stringify(definition.allowedTools)},
            ${JSON.stringify(definition.modelSelection)},
            ${definition.runtimeMode}, ${definition.enabled ? 1 : 0}, ${definition.revision},
            ${definition.createdAt}, ${definition.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getDefinition,
      listDefinitionsForProject: (projectId) =>
        sql<BotDefinitionRow>`
          SELECT id, project_id AS projectId, role, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled, revision, created_at AS createdAt, updated_at AS updatedAt
          FROM bosun_bot_definitions
          WHERE project_id = ${projectId} OR project_id IS NULL
          ORDER BY role, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeDefinition), catch: decodeError }),
          ),
        ),
      insertRun: (run) =>
        sql`
          INSERT OR IGNORE INTO bosun_bot_runs (
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
          FROM bosun_bot_runs AS r WHERE dispatch_state = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM bosun_bot_handoffs AS h
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
          readonly dispatchState: "queued" | "started";
          readonly lastError: string | null;
          readonly createdAt: string;
          readonly turnState: BotRunSummary["turnState"];
        }>`
          SELECT id, bot_id AS botId, project_id AS projectId, thread_id AS threadId,
            dispatch_state AS dispatchState, last_error AS lastError, created_at AS createdAt,
            COALESCE((
              SELECT state FROM projection_turns AS t
              WHERE t.thread_id = r.thread_id ORDER BY t.row_id DESC LIMIT 1
            ), 'missing') AS turnState
          FROM bosun_bot_runs AS r WHERE project_id = ${projectId}
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
          UPDATE bosun_bot_runs SET dispatch_state = 'started',
            last_error = NULL, dispatched_at = ${dispatchedAt}
          WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      nextRecoveryAttempt: (id) =>
        sql<{ readonly recoveryAttempt: number }>`
          UPDATE bosun_bot_runs SET recovery_attempt = recovery_attempt + 1
          WHERE id = ${id} RETURNING recovery_attempt AS recoveryAttempt
        `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => rows[0]?.recoveryAttempt ?? 0),
        ),
      markDispatchError: (id, error) =>
        sql`
          UPDATE bosun_bot_runs SET last_error = ${error} WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
    } satisfies BotStoreShape;
  }),
);
