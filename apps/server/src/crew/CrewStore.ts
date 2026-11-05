import {
  BOT_HEADQUARTERS_RUN_PREFIX,
  type BotLongConversation,
  PROJECT_HEADQUARTERS_RUN_PREFIX,
  CREW_DISPATCH_STATE,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type CrewDispatchState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  decodeLinkedWorkflow,
  encodeLinkedWorkflow,
  type LinkedWorkflow,
} from "./linkedWorkflow.ts";
import {
  decodeOpeningMessage,
  encodeOpeningMessage,
  type OpeningMessage,
} from "./CrewThreadRuntime.ts";

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
  /** How a project's standing manager handles a long conversation; other members ignore it. */
  readonly longConversation: BotLongConversation;
  /** When someone saved its settings in its project; role edits leave it alone from then on. */
  readonly customizedAt: string | null;
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
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly leadRoleId: string;
  readonly crewRoleIds: ReadonlyArray<string>;
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

/**
 * Where a crew run's thread works when it isn't the project's checkout: a worktree, or one its
 * thread makes from `baseRef` as it starts.
 */
export type CrewWorkspace =
  | { readonly branch: string; readonly worktreePath: string }
  | { readonly branch: string; readonly baseRef: string };

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
  readonly workspace: CrewWorkspace | null;
  /** Sent with the thread's first message: a feature's brief attachments, on its first stage. */
  readonly openingMessage?: OpeningMessage | null;
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
  readonly longConversation: string;
  readonly customizedAt: string | null;
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
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly baseRef: string | null;
  readonly openingMessageJson: string | null;
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
  longConversation: row.longConversation === "new-session" ? "new-session" : "compact",
  customizedAt: row.customizedAt,
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
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

interface WorkflowRow extends Omit<Workflow, "crewRoleIds"> {
  readonly crewRoleIdsJson: string;
}

const decodeWorkflow = ({ crewRoleIdsJson, ...row }: WorkflowRow): Workflow => {
  const crewRoleIds: unknown = JSON.parse(crewRoleIdsJson);
  return {
    ...row,
    crewRoleIds: Array.isArray(crewRoleIds)
      ? crewRoleIds.filter((id): id is string => typeof id === "string")
      : [],
  };
};

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
  workspace: !row.branch
    ? null
    : row.worktreePath
      ? { branch: row.branch, worktreePath: row.worktreePath }
      : row.baseRef
        ? { branch: row.branch, baseRef: row.baseRef }
        : null,
  openingMessage: decodeOpeningMessage(row.openingMessageJson),
});

export interface CrewStoreShape {
  readonly insertRole: (role: Role) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateRole: (
    role: Role,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getRole: (id: string) => Effect.Effect<Role | null, PersistenceSqlError>;
  readonly listRoles: () => Effect.Effect<ReadonlyArray<Role>, PersistenceSqlError>;
  readonly insertWorkflow: (workflow: Workflow) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateWorkflow: (
    workflow: Workflow,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly deleteWorkflow: (id: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly getWorkflow: (id: string) => Effect.Effect<Workflow | null, PersistenceSqlError>;
  readonly listWorkflows: () => Effect.Effect<ReadonlyArray<Workflow>, PersistenceSqlError>;
  readonly insertMember: (member: CrewMember) => Effect.Effect<void, PersistenceSqlError>;
  /**
   * Writes `member` over the stored row while it is still at `expectedRevision` and nobody
   * customized it in its project. False when either check stopped the write.
   */
  readonly updateMember: (
    member: CrewMember,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /**
   * Writes `member` while it is still at `expectedRevision`, customized or not, and stores its
   * `customizedAt`: saving a project's manager sets it, resetting it to its role clears it.
   */
  readonly saveMember: (
    member: CrewMember,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Members of `roleId` that belong to a project but not to one feature. */
  readonly listProjectMembersOfRole: (
    roleId: string,
  ) => Effect.Effect<ReadonlyArray<CrewMember>, PersistenceSqlError>;
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PersistenceSqlError, R>;
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
  /** The run a crew thread works for, or null for any other thread. */
  readonly getRunByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<CrewRun | null, PersistenceSqlError>;
  readonly listQueuedRuns: () => Effect.Effect<ReadonlyArray<CrewRun>, PersistenceSqlError>;
  /** Keeps the workflow a linked environment sent with run `runId`; the first one stays. */
  readonly setRunWorkflow: (
    runId: string,
    workflow: LinkedWorkflow,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** The workflow a linked environment sent with the run behind `threadId`, if any. */
  readonly getThreadWorkflow: (
    threadId: ThreadId,
  ) => Effect.Effect<LinkedWorkflow | null, PersistenceSqlError>;
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
          enabled, long_conversation AS longConversation, customized_at AS customizedAt,
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
          enabled,
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
          COALESCE(b.allowed_tools_json, m.allowed_tools_json, r.allowed_tools_json)
            AS allowedToolsJson,
          r.member_revision AS memberRevision,
          COALESCE(b.model_selection_json, m.model_selection_json, r.model_selection_json)
            AS modelSelectionJson,
          COALESCE(b.runtime_mode, m.runtime_mode, r.runtime_mode) AS runtimeMode,
          r.dispatch_state AS dispatchState, r.recovery_attempt AS recoveryAttempt,
          r.last_error AS lastError,
          r.created_at AS createdAt, r.dispatched_at AS dispatchedAt,
          r.branch, r.worktree_path AS worktreePath, r.base_ref AS baseRef,
          r.opening_message_json AS openingMessageJson
        FROM crew_runs AS r
        LEFT JOIN bots AS b
          ON r.id LIKE ${`${BOT_HEADQUARTERS_RUN_PREFIX}%`} AND b.id = r.member_id
        LEFT JOIN crew_members AS m
          ON r.id LIKE ${`${PROJECT_HEADQUARTERS_RUN_PREFIX}%`} AND m.id = r.member_id
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
            ${role.runtimeMode}, ${role.enabled ? 1 : 0}, 0, ${role.revision},
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
            enabled,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM roles
          ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeRole), catch: decodeError }),
          ),
        ),
      insertWorkflow: (workflow) =>
        sql`
          INSERT INTO workflows (
            id, name, instructions, lead_role_id, crew_role_ids_json, revision, created_at, updated_at
          ) VALUES (
            ${workflow.id}, ${workflow.name}, ${workflow.instructions}, ${workflow.leadRoleId},
            ${JSON.stringify(workflow.crewRoleIds)}, ${workflow.revision},
            ${workflow.createdAt}, ${workflow.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      updateWorkflow: (workflow, expectedRevision) =>
        sql<{ readonly id: string }>`
          UPDATE workflows SET
            name = ${workflow.name}, instructions = ${workflow.instructions},
            lead_role_id = ${workflow.leadRoleId},
            crew_role_ids_json = ${JSON.stringify(workflow.crewRoleIds)},
            revision = ${workflow.revision}, updated_at = ${workflow.updatedAt}
          WHERE id = ${workflow.id} AND revision = ${expectedRevision}
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      deleteWorkflow: (id) =>
        sql`DELETE FROM workflows WHERE id = ${id}`.pipe(
          Effect.asVoid,
          Effect.mapError(queryError),
        ),
      getWorkflow: (id) =>
        sql<WorkflowRow>`
          SELECT id, name, instructions, lead_role_id AS leadRoleId,
            crew_role_ids_json AS crewRoleIdsJson, revision, created_at AS createdAt,
            updated_at AS updatedAt
          FROM workflows WHERE id = ${id}
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => (rows[0] ? decodeWorkflow(rows[0]) : null),
              catch: decodeError,
            }),
          ),
        ),
      listWorkflows: () =>
        sql<WorkflowRow>`
          SELECT id, name, instructions, lead_role_id AS leadRoleId,
            crew_role_ids_json AS crewRoleIdsJson, revision, created_at AS createdAt,
            updated_at AS updatedAt
          FROM workflows ORDER BY name, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeWorkflow), catch: decodeError }),
          ),
        ),
      insertMember: (member) =>
        sql`
          INSERT INTO crew_members (
            id, project_id, feature_id, role_id, role_revision, name, instructions,
            allowed_tools_json, model_selection_json, runtime_mode, enabled,
            long_conversation, customized_at, revision, created_at, updated_at
          ) VALUES (
            ${member.id}, ${member.projectId}, ${member.featureId},
            ${member.roleId}, ${member.roleRevision}, ${member.name},
            ${member.instructions}, ${JSON.stringify(member.allowedTools)},
            ${JSON.stringify(member.modelSelection)},
            ${member.runtimeMode}, ${member.enabled ? 1 : 0},
            ${member.longConversation}, ${member.customizedAt}, ${member.revision},
            ${member.createdAt}, ${member.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      updateMember: (member, expectedRevision) =>
        sql<{ readonly id: string }>`
          UPDATE crew_members SET
            role_revision = ${member.roleRevision}, name = ${member.name},
            instructions = ${member.instructions},
            allowed_tools_json = ${JSON.stringify(member.allowedTools)},
            model_selection_json = ${JSON.stringify(member.modelSelection)},
            runtime_mode = ${member.runtimeMode}, enabled = ${member.enabled ? 1 : 0},
            long_conversation = ${member.longConversation},
            revision = ${member.revision}, updated_at = ${member.updatedAt}
          WHERE id = ${member.id} AND revision = ${expectedRevision} AND customized_at IS NULL
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      saveMember: (member, expectedRevision) =>
        sql<{ readonly id: string }>`
          UPDATE crew_members SET
            role_revision = ${member.roleRevision}, name = ${member.name},
            instructions = ${member.instructions},
            allowed_tools_json = ${JSON.stringify(member.allowedTools)},
            model_selection_json = ${JSON.stringify(member.modelSelection)},
            runtime_mode = ${member.runtimeMode}, enabled = ${member.enabled ? 1 : 0},
            long_conversation = ${member.longConversation},
            customized_at = ${member.customizedAt},
            revision = ${member.revision}, updated_at = ${member.updatedAt}
          WHERE id = ${member.id} AND revision = ${expectedRevision}
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(queryError),
        ),
      listProjectMembersOfRole: (roleId) =>
        sql<CrewMemberRow>`
          SELECT id, project_id AS projectId, feature_id AS featureId,
            role_id AS roleId, role_revision AS roleRevision, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled, long_conversation AS longConversation, customized_at AS customizedAt,
            revision, created_at AS createdAt, updated_at AS updatedAt
          FROM crew_members
          WHERE role_id = ${roleId} AND project_id IS NOT NULL AND feature_id IS NULL
            AND customized_at IS NULL
          ORDER BY id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeMember), catch: decodeError }),
          ),
        ),
      transaction: (effect) =>
        sql
          .withTransaction(effect)
          .pipe(
            Effect.mapError((error) => (SqlError.isSqlError(error) ? queryError(error) : error)),
          ),
      getMember,
      listMembersForProject: (projectId) =>
        sql<CrewMemberRow>`
          SELECT id, project_id AS projectId, feature_id AS featureId,
            role_id AS roleId, role_revision AS roleRevision, name, instructions,
            allowed_tools_json AS allowedToolsJson,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            enabled, long_conversation AS longConversation, customized_at AS customizedAt,
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
            created_at, dispatched_at, branch, worktree_path, base_ref, opening_message_json
          ) VALUES (
            ${run.id}, ${run.memberId}, ${run.projectId}, ${run.threadId}, ${run.taskText},
            ${run.title}, ${run.instructions}, ${JSON.stringify(run.allowedTools)},
            ${run.memberRevision}, ${JSON.stringify(run.modelSelection)},
            ${run.runtimeMode}, ${run.dispatchState}, ${run.recoveryAttempt}, ${run.lastError}, ${run.createdAt},
            ${run.dispatchedAt}, ${run.workspace?.branch ?? null},
            ${run.workspace && "worktreePath" in run.workspace ? run.workspace.worktreePath : null},
            ${run.workspace && "baseRef" in run.workspace ? run.workspace.baseRef : null},
            ${encodeOpeningMessage(run.openingMessage)}
          )
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getRun,
      setRunWorkflow: (runId, workflow) =>
        sql`
          INSERT OR IGNORE INTO crew_run_workflows (run_id, workflow_json)
          VALUES (${runId}, ${encodeLinkedWorkflow(workflow)})
        `.pipe(Effect.asVoid, Effect.mapError(queryError)),
      getThreadWorkflow: (threadId) =>
        sql<{ readonly json: string }>`
          SELECT w.workflow_json AS json
          FROM crew_run_workflows AS w JOIN crew_runs AS r ON r.id = w.run_id
          WHERE r.thread_id = ${threadId}
        `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => decodeLinkedWorkflow(rows[0]?.json)),
        ),
      getRunByThread: (threadId) =>
        sql<{ readonly id: string }>`SELECT id FROM crew_runs WHERE thread_id = ${threadId}`.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) => (rows[0] ? getRun(rows[0].id) : Effect.succeed(null))),
        ),
      listQueuedRuns: () =>
        sql<CrewRunRow>`
          SELECT id, member_id AS memberId, project_id AS projectId, thread_id AS threadId,
            task_text AS taskText, title, instructions,
            allowed_tools_json AS allowedToolsJson, member_revision AS memberRevision,
            model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
            dispatch_state AS dispatchState, recovery_attempt AS recoveryAttempt,
            last_error AS lastError,
            created_at AS createdAt, dispatched_at AS dispatchedAt,
            branch, worktree_path AS worktreePath, base_ref AS baseRef,
            opening_message_json AS openingMessageJson
          FROM crew_runs AS r WHERE dispatch_state = ${CREW_DISPATCH_STATE.QUEUED}
            -- A workflow dispatches its stages' runs itself, and fails a stage whose dispatch failed.
            AND r.id NOT LIKE 'bot-handoff:%'
          ORDER BY created_at, id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeRun), catch: decodeError }),
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
