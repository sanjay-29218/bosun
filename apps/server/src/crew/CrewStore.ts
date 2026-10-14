import {
  BOT_HEADQUARTERS_RUN_PREFIX,
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type CrewDispatchState,
  type CrewTurnState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface CrewMember {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly featureId: string | null;
  readonly roleId: string | null;
  readonly roleRevision: number | null;
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

export interface Role {
  readonly id: string;
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

export interface CrewHierarchyNode {
  readonly memberId: string;
  readonly parentMemberId: string | null;
  readonly position: number;
}

export interface CrewDelegationGrant {
  readonly sourceMemberId: string;
  readonly targetMemberId: string;
}

export interface CrewRun {
  readonly id: string;
  readonly memberId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly taskText: string;
  readonly title: string;
  readonly instructions: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly memberRevision: number;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly dispatchState: CrewDispatchState;
  readonly recoveryAttempt: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
}

export interface CrewRunSummary {
  readonly id: string;
  readonly memberId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly dispatchState: CrewDispatchState;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly turnState: CrewTurnState;
}

interface CrewMemberRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly featureId: string | null;
  readonly roleId: string | null;
  readonly roleRevision: number | null;
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

interface RoleRow {
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
}

interface CrewRunRow {
  readonly id: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly taskText: string;
  readonly title: string;
  readonly instructions: string;
  readonly allowedToolsJson: string;
  readonly memberRevision: number;
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

const decodeMember = (row: CrewMemberRow): CrewMember => ({
  id: row.id,
  projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
  featureId: row.featureId,
  roleId: row.roleId,
  roleRevision: row.roleRevision,
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

const decodeRole = (row: RoleRow): Role => ({
  id: row.id,
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

const decodeRun = (row: CrewRunRow): CrewRun => ({
  id: row.id,
  memberId: row.memberId,
  projectId: ProjectId.make(row.projectId),
  threadId: ThreadId.make(row.threadId),
  taskText: row.taskText,
  title: row.title,
  instructions: row.instructions,
  allowedTools: decodeAllowedTools(row.allowedToolsJson),
  memberRevision: row.memberRevision,
  modelSelection: decodeModelSelection(row.modelSelectionJson),
  runtimeMode: parseRuntimeMode(row.runtimeMode),
  dispatchState:
    row.dispatchState === CREW_DISPATCH_STATE.STARTED
      ? CREW_DISPATCH_STATE.STARTED
      : CREW_DISPATCH_STATE.QUEUED,
  recoveryAttempt: row.recoveryAttempt,
  lastError: row.lastError,
  createdAt: row.createdAt,
  dispatchedAt: row.dispatchedAt,
});

export interface CrewStoreShape {
  readonly insertRole: (role: Role) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateRole: (
    role: Role,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getRole: (id: string) => Effect.Effect<Role | null, PersistenceSqlError>;
  readonly listRoles: () => Effect.Effect<ReadonlyArray<Role>, PersistenceSqlError>;
  readonly insertMember: (member: CrewMember) => Effect.Effect<void, PersistenceSqlError>;
  readonly getMember: (id: string) => Effect.Effect<CrewMember | null, PersistenceSqlError>;
  readonly listMembersForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewMember>, PersistenceSqlError>;
  readonly grantDelegation: (
    sourceMemberId: string,
    targetMemberId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /**
   * Whether a run of `sourceId` in `projectId` may delegate to the member: by an explicit
   * grant, or because the source is a top-level bot and the member is on `projectId`. New
   * delegations also check that the bot owns the project, so a later move does not strand
   * work that already started.
   */
  readonly canDelegate: (
    sourceId: string,
    targetMemberId: string,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /** A crew member or top-level bot that can act in runs; bots are always enabled. */
  readonly getActor: (
    id: string,
  ) => Effect.Effect<
    { readonly id: string; readonly enabled: boolean } | null,
    PersistenceSqlError
  >;
  readonly listDelegationGrantsForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewDelegationGrant>, PersistenceSqlError>;
  readonly revokeDelegation: (
    sourceMemberId: string,
    targetMemberId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listHierarchyForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewHierarchyNode>, PersistenceSqlError>;
  readonly setParent: (
    memberId: string,
    parentMemberId: string | null,
    position: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly insertRun: (run: CrewRun) => Effect.Effect<void, PersistenceSqlError>;
  readonly getRun: (id: string) => Effect.Effect<CrewRun | null, PersistenceSqlError>;
  readonly listQueuedRuns: () => Effect.Effect<ReadonlyArray<CrewRun>, PersistenceSqlError>;
  readonly listRunSummaries: (
    projectId: ProjectId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CrewRunSummary>, PersistenceSqlError>;
  readonly markStarted: (
    id: string,
    dispatchedAt: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Moves a long-lived run to another project, for a headquarters whose project was deleted. */
  readonly moveRun: (id: string, projectId: ProjectId) => Effect.Effect<void, PersistenceSqlError>;
  readonly nextRecoveryAttempt: (id: string) => Effect.Effect<number, PersistenceSqlError>;
  readonly markDispatchError: (
    id: string,
    error: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class CrewStore extends Context.Service<CrewStore, CrewStoreShape>()("t3/crew/CrewStore") {}

export const CrewStoreLive = Layer.effect(
  CrewStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queryError = toPersistenceSqlError("CrewStore.query");
    const decodeError = toPersistenceSqlError("CrewStore.decode");

    const getMember = (id: string) =>
      sql<CrewMemberRow>`
        SELECT id, project_id AS projectId, feature_id AS featureId,
          role_id AS roleId, role_revision AS roleRevision, name, instructions,
          allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          enabled,
          revision, created_at AS createdAt, updated_at AS updatedAt
        FROM crew_members WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeMember(rows[0]) : null),
            catch: decodeError,
          }),
        ),
      );

    const getRole = (id: string) =>
      sql<RoleRow>`
        SELECT id, name, instructions,
          allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          enabled, auto_create_for_feature AS autoCreateForFeature,
          revision, created_at AS createdAt, updated_at AS updatedAt
        FROM roles WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeRole(rows[0]) : null), catch: decodeError }),
        ),
      );

    // A bot's headquarters run lasts as long as the bot, so it follows the bot's current grants,
    // runtime mode and model. Its instructions only ever reach the thread's first message.
    const getRun = (id: string) =>
      sql<CrewRunRow>`
        SELECT r.id, r.member_id AS memberId, r.project_id AS projectId, r.thread_id AS threadId,
          r.task_text AS taskText, r.title, r.instructions,
          COALESCE(b.allowed_tools_json, r.allowed_tools_json) AS allowedToolsJson,
          r.member_revision AS memberRevision,
          COALESCE(b.model_selection_json, r.model_selection_json) AS modelSelectionJson,
          COALESCE(b.runtime_mode, r.runtime_mode) AS runtimeMode,
          r.dispatch_state AS dispatchState, r.recovery_attempt AS recoveryAttempt,
          r.last_error AS lastError,
          r.created_at AS createdAt, r.dispatched_at AS dispatchedAt
        FROM crew_runs AS r
        LEFT JOIN bots AS b
          ON r.id LIKE ${`${BOT_HEADQUARTERS_RUN_PREFIX}%`} AND b.id = r.member_id
        WHERE r.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeRun(rows[0]) : null), catch: decodeError }),
        ),
      );

    return {
      insertRole: (role) =>
        sql`
          INSERT INTO roles (
            id, name, instructions, allowed_tools_json,
            model_selection_json, runtime_mode, enabled, auto_create_for_feature,
            revision, created_at, updated_at
          ) VALUES (
            ${role.id}, ${role.name}, ${role.instructions},
            ${JSON.stringify(role.allowedTools)}, ${JSON.stringify(role.modelSelection)},
            ${role.runtimeMode}, ${role.enabled ? 1 : 0},
            ${role.autoCreateForFeature ? 1 : 0}, ${role.revision},
            ${role.createdAt}, ${role.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      updateRole: (role, expectedRevision) =>
        sql<{ readonly id: string }>`
          UPDATE roles SET
            name = ${role.name}, instructions = ${role.instructions},
            allowed_tools_json = ${JSON.stringify(role.allowedTools)},
            model_selection_json = ${JSON.stringify(role.modelSelection)},
            runtime_mode = ${role.runtimeMode}, enabled = ${role.enabled ? 1 : 0},
            auto_create_for_feature = ${role.autoCreateForFeature ? 1 : 0},
            revision = ${role.revision}, updated_at = ${role.updatedAt}
          WHERE id = ${role.id} AND revision = ${expectedRevision}
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      getRole,
      listRoles: () =>
        sql<RoleRow>`
          SELECT id, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled, auto_create_for_feature AS autoCreateForFeature,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM roles
          ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeRole), catch: decodeError }),
          ),
        ),
      insertMember: (member) =>
        sql`
          INSERT INTO crew_members (
            id, project_id, feature_id, role_id, role_revision, name, instructions,
            allowed_tools_json, model_selection_json, runtime_mode, enabled,
            revision, created_at, updated_at
          ) VALUES (
            ${member.id}, ${member.projectId}, ${member.featureId},
            ${member.roleId}, ${member.roleRevision}, ${member.name},
            ${member.instructions}, ${JSON.stringify(member.allowedTools)},
            ${JSON.stringify(member.modelSelection)},
            ${member.runtimeMode}, ${member.enabled ? 1 : 0},
            ${member.revision},
            ${member.createdAt}, ${member.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getMember,
      listMembersForProject: (projectId) =>
        sql<CrewMemberRow>`
          SELECT id, project_id AS projectId, feature_id AS featureId,
            role_id AS roleId, role_revision AS roleRevision, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM crew_members
          WHERE project_id = ${projectId} OR project_id IS NULL
          ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeMember), catch: decodeError }),
          ),
        ),
      grantDelegation: (sourceMemberId, targetMemberId) =>
        sql`
          INSERT OR IGNORE INTO crew_delegation_grants (source_member_id, target_member_id)
          VALUES (${sourceMemberId}, ${targetMemberId})
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      canDelegate: (sourceId, targetMemberId, projectId) =>
        sql<{ readonly allowed: number }>`
          SELECT 1 AS allowed FROM crew_delegation_grants
          WHERE source_member_id = ${sourceId} AND target_member_id = ${targetMemberId}
          UNION ALL
          SELECT 1 AS allowed FROM bots AS b JOIN crew_members AS m ON m.id = ${targetMemberId}
          WHERE b.id = ${sourceId} AND m.project_id = ${projectId}
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      getActor: (id) =>
        sql<{ readonly id: string; readonly enabled: number }>`
          SELECT id, enabled FROM (
            SELECT id, 1 AS enabled, 0 AS rank FROM bots WHERE id = ${id}
            UNION ALL
            SELECT id, enabled, 1 AS rank FROM crew_members WHERE id = ${id}
          ) ORDER BY rank LIMIT 1
        `.pipe(
          Effect.map((rows) =>
            rows[0] ? { id: rows[0].id, enabled: rows[0].enabled === 1 } : null,
          ),
          Effect.mapError(queryError),
        ),
      listDelegationGrantsForProject: (projectId) =>
        sql<CrewDelegationGrant>`
          SELECT g.source_member_id AS sourceMemberId, g.target_member_id AS targetMemberId
          FROM crew_delegation_grants AS g JOIN crew_members AS target ON target.id = g.target_member_id
          WHERE target.project_id = ${projectId}
          ORDER BY g.source_member_id, g.target_member_id
        `.pipe(Effect.mapError(queryError)),
      revokeDelegation: (sourceMemberId, targetMemberId) =>
        sql`
          DELETE FROM crew_delegation_grants
          WHERE source_member_id = ${sourceMemberId} AND target_member_id = ${targetMemberId}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      listHierarchyForProject: (projectId) =>
        sql<CrewHierarchyNode>`
          SELECT h.member_id AS memberId, h.parent_member_id AS parentMemberId, h.position
          FROM crew_hierarchy AS h JOIN crew_members AS b ON b.id = h.member_id
          WHERE b.project_id = ${projectId} OR b.project_id IS NULL
          ORDER BY h.parent_member_id, h.position, h.member_id
        `.pipe(Effect.mapError(queryError)),
      setParent: (memberId, parentMemberId, position) =>
        sql<{ readonly memberId: string }>`
          WITH RECURSIVE ancestors(member_id, parent_member_id) AS (
            SELECT member_id, parent_member_id FROM crew_hierarchy WHERE member_id = ${parentMemberId}
            UNION ALL
            SELECT h.member_id, h.parent_member_id FROM crew_hierarchy AS h
            JOIN ancestors AS a ON h.member_id = a.parent_member_id
          )
          UPDATE crew_hierarchy
          SET parent_member_id = ${parentMemberId}, position = ${position}
          WHERE member_id = ${memberId}
            AND NOT EXISTS (SELECT 1 FROM ancestors WHERE member_id = ${memberId})
          RETURNING member_id AS memberId
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      insertRun: (run) =>
        sql`
          INSERT OR IGNORE INTO crew_runs (
            id, member_id, project_id, thread_id, task_text, title, instructions,
            allowed_tools_json, member_revision,
            model_selection_json, runtime_mode, dispatch_state, recovery_attempt, last_error,
            created_at, dispatched_at
          ) VALUES (
            ${run.id}, ${run.memberId}, ${run.projectId}, ${run.threadId}, ${run.taskText},
            ${run.title}, ${run.instructions}, ${JSON.stringify(run.allowedTools)},
            ${run.memberRevision}, ${JSON.stringify(run.modelSelection)},
            ${run.runtimeMode}, ${run.dispatchState}, ${run.recoveryAttempt}, ${run.lastError}, ${run.createdAt},
            ${run.dispatchedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getRun,
      listQueuedRuns: () =>
        sql<CrewRunRow>`
          SELECT id, member_id AS memberId, project_id AS projectId, thread_id AS threadId,
            task_text AS taskText, title, instructions,
            allowed_tools_json AS allowedToolsJson, member_revision AS memberRevision,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            dispatch_state AS dispatchState, recovery_attempt AS recoveryAttempt,
            last_error AS lastError,
            created_at AS createdAt, dispatched_at AS dispatchedAt
          FROM crew_runs AS r WHERE dispatch_state = ${CREW_DISPATCH_STATE.QUEUED}
            AND NOT EXISTS (
              SELECT 1 FROM crew_handoffs AS h
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
          readonly memberId: string;
          readonly projectId: string;
          readonly threadId: string;
          readonly dispatchState: CrewDispatchState;
          readonly lastError: string | null;
          readonly createdAt: string;
          readonly turnState: CrewRunSummary["turnState"];
        }>`
          SELECT id, member_id AS memberId, project_id AS projectId, thread_id AS threadId,
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
            ), ${CREW_TURN_STATE.MISSING}) AS turnState
          FROM crew_runs AS r WHERE project_id = ${projectId}
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
      moveRun: (id, projectId) =>
        sql`UPDATE crew_runs SET project_id = ${projectId} WHERE id = ${id}`.pipe(
          Effect.asVoid,
          Effect.mapError(queryError),
        ),
      markStarted: (id, dispatchedAt) =>
        sql`
          UPDATE crew_runs SET dispatch_state = ${CREW_DISPATCH_STATE.STARTED},
            last_error = NULL, dispatched_at = ${dispatchedAt}
          WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      nextRecoveryAttempt: (id) =>
        sql<{ readonly recoveryAttempt: number }>`
          UPDATE crew_runs SET recovery_attempt = recovery_attempt + 1
          WHERE id = ${id} RETURNING recovery_attempt AS recoveryAttempt
        `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => rows[0]?.recoveryAttempt ?? 0),
        ),
      markDispatchError: (id, error) =>
        sql`
          UPDATE crew_runs SET last_error = ${error} WHERE id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
    } satisfies CrewStoreShape;
  }),
);
