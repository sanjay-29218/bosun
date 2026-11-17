import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { BotAvatar } from "./bots.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor, ProjectRemoteManager } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Crew mode: global Roles (planner, designer, builder, reviewer, feature manager...) and the
 * crew members a project or feature instantiates from them. Runs are the durable work those
 * members do. "Bot" is reserved for the top-level bots that own projects.
 */

export const CREW_TURN_STATE = {
  MISSING: "missing",
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
  ERROR: "error",
} as const;
export type CrewTurnState = (typeof CREW_TURN_STATE)[keyof typeof CREW_TURN_STATE];

export const CREW_DISPATCH_STATE = {
  QUEUED: "queued",
  STARTED: "started",
} as const;
export type CrewDispatchState = (typeof CREW_DISPATCH_STATE)[keyof typeof CREW_DISPATCH_STATE];

/** The role that leads a feature in the built-in workflows; each project's lead is made from it. */
export const FEATURE_MANAGER_ROLE_ID = "role:feature-manager";

/** A crew member: a role instantiated for a project, a feature, or the whole environment. */
export const CrewMemberSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  featureId: Schema.NullOr(Schema.String),
  roleId: Schema.NullOr(Schema.String),
  name: Schema.String,
  enabled: Schema.Boolean,
});
export type CrewMemberSummary = typeof CrewMemberSummary.Type;

export const CrewProjectInput = Schema.Struct({ projectId: ProjectId });

/** The linked machine a copied workflow or role is managed from, where it is edited. */
export const LibraryOwner = Schema.Struct({ environmentId: EnvironmentId, label: Schema.String });
export type LibraryOwner = typeof LibraryOwner.Type;

/**
 * A linked machine's copy of a workflow or role, as the machine that owns it sees it. Every
 * linked machine gets one; a machine with no entry hasn't answered since it was linked.
 */
export const LibraryCopy = Schema.Struct({
  environmentId: EnvironmentId,
  /** The revision that machine last got; null until it got one. */
  deliveredRevision: Schema.NullOr(Schema.Int),
  deliveredAt: Schema.NullOr(Schema.String),
  /** Why it isn't there: that machine has its own with the same id, or can't take copies. */
  problem: Schema.NullOr(Schema.String),
});
export type LibraryCopy = typeof LibraryCopy.Type;

/** Older servers send neither. */
const libraryCopyFields = {
  /** Set on a copy: it is edited on that machine and read-only here. */
  managedFrom: Schema.NullOr(LibraryOwner).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  copies: Schema.Array(LibraryCopy).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
};

/** A global role: who a lead or crew member is. Editing it never rewrites existing members. */
export const RoleConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
  enabled: Schema.Boolean,
  revision: Schema.Int,
  ...libraryCopyFields,
});
export type RoleConfig = typeof RoleConfig.Type;
const roleFields = {
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
};
export const RoleCreateInput = Schema.Struct({ ...roleFields });
export const RoleUpdateInput = Schema.Struct({
  ...roleFields,
  expectedRevision: Schema.Int,
  enabled: Schema.Boolean,
});
/** The workflow a feature follows when none is chosen. People can edit it but not delete it. */
export const FEATURE_DELIVERY_WORKFLOW_ID = "workflow:feature-delivery";
/**
 * A workflow sent by value with a bot's request from a linked environment: the workflow at its
 * revision there, and the roles it names. A feature started for that request runs on these
 * instead of the library where it runs, which never gains them.
 */
/** A role as it travels between machines. */
export const SnapshotRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
  /** Older peers require it. Every role runs with full access, so it is ignored. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type SnapshotRole = typeof SnapshotRole.Type;
export const WorkflowSnapshot = Schema.Struct({
  workflow: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    instructions: Schema.String,
    leadRoleId: Schema.String,
    crewRoleIds: Schema.Array(Schema.String),
    revision: Schema.Int,
  }),
  roles: Schema.Array(SnapshotRole),
});
export type WorkflowSnapshot = typeof WorkflowSnapshot.Type;
/** The built-in workflow whose lead splits big work into child features. */
export const EPIC_WORKFLOW_ID = "workflow:epic";

/**
 * How a kind of work runs: the role that leads it, the roles it can hand work to, and plain
 * instructions the lead follows. A feature's lead gets them with the brief as its first message.
 */
export const WorkflowConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  leadRoleId: Schema.String,
  crewRoleIds: Schema.Array(Schema.String),
  revision: Schema.Int,
  ...libraryCopyFields,
});
export type WorkflowConfig = typeof WorkflowConfig.Type;
const workflowFields = {
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  leadRoleId: Schema.String,
  crewRoleIds: Schema.Array(Schema.String),
};
export const WorkflowCreateInput = Schema.Struct({ ...workflowFields });
export const WorkflowUpdateInput = Schema.Struct({
  ...workflowFields,
  expectedRevision: Schema.Int,
});
export const WorkflowDeleteInput = Schema.Struct({ id: Schema.String });

/** Creates the default roles and workflow that are missing, using `modelSelection` for each role. */
export const CrewInitializeInput = Schema.Struct({ modelSelection: ModelSelection });

export const CrewHierarchyNode = Schema.Struct({
  memberId: Schema.String,
  parentMemberId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const CrewDelegationGrant = Schema.Struct({
  sourceMemberId: Schema.String,
  targetMemberId: Schema.String,
});
export const CrewConfigurationSnapshot = Schema.Struct({
  hierarchy: Schema.Array(CrewHierarchyNode),
  delegationGrants: Schema.Array(CrewDelegationGrant),
});
export const CrewInstantiateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  roleId: Schema.String,
});
export const CrewSetHierarchyInput = Schema.Struct({
  projectId: ProjectId,
  memberId: Schema.String,
  parentMemberId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const CrewSetDelegationInput = Schema.Struct({
  projectId: ProjectId,
  sourceMemberId: Schema.String,
  targetMemberId: Schema.String,
  allowed: Schema.Boolean,
});

/** The bot look a person chose for a project's manager. */
export const ProjectManagerIcon = Schema.Struct({ avatar: BotAvatar, color: ProjectIconColor });
export type ProjectManagerIcon = typeof ProjectManagerIcon.Type;

/** A project's manager as it is now, or as the role would make it before its first use. */
export const ProjectManagerSettings = Schema.Struct({
  projectId: ProjectId,
  /** Off, its bot does the project's work itself and its thread is archived. */
  enabled: Schema.Boolean,
  instructions: Schema.String,
  /** Saved in the project, rather than its defaults. */
  customized: Schema.Boolean,
  /** The member's revision; 0 before the project has one. */
  revision: Schema.Int,
  /** Its standing thread, null until it is first opened. */
  threadId: Schema.NullOr(ThreadId),
  /** Null shows the look clients derive from the project id. */
  icon: Schema.NullOr(ProjectManagerIcon),
});
export type ProjectManagerSettings = typeof ProjectManagerSettings.Type;
export const ProjectManagerUpdateInput = Schema.Struct({
  projectId: ProjectId,
  instructions: Schema.String,
  expectedRevision: Schema.Int,
});
export type ProjectManagerUpdateInput = typeof ProjectManagerUpdateInput.Type;
export const ProjectManagerResetInput = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: Schema.Int,
});
export type ProjectManagerResetInput = typeof ProjectManagerResetInput.Type;
export const ProjectManagerEnabledInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type ProjectManagerEnabledInput = typeof ProjectManagerEnabledInput.Type;
export const ProjectManagerIconInput = Schema.Struct({
  projectId: ProjectId,
  icon: Schema.NullOr(ProjectManagerIcon),
});
export type ProjectManagerIconInput = typeof ProjectManagerIconInput.Type;

/**
 * Where a project's manager lives. `remoteManager` set moves it to another
 * environment's copy and retires this copy's manager; null brings it here. `retired` notes in the
 * manager's thread here which copy's manager was retired for it.
 */
export const ProjectManagerPlacementInput = Schema.Struct({
  projectId: ProjectId,
  remoteManager: Schema.optionalKey(Schema.NullOr(ProjectRemoteManager)),
  retired: Schema.optionalKey(
    Schema.Struct({ environmentLabel: Schema.String, threadId: ThreadId }),
  ),
});
export type ProjectManagerPlacementInput = typeof ProjectManagerPlacementInput.Type;
/** The manager thread a move archived here, if any. */
export const ProjectManagerPlacementResult = Schema.Struct({
  retiredThreadId: Schema.NullOr(ThreadId),
});
export type ProjectManagerPlacementResult = typeof ProjectManagerPlacementResult.Type;

/** A project's manager thread, made and opened on first use. */
export const ProjectManagerThread = Schema.Struct({ threadId: ThreadId });
/** Starts a standing thread (a bot's headquarters or a project's manager) over in a new session. */
export const CrewStartNewSessionInput = Schema.Struct({ threadId: ThreadId });

export class CrewOperationError extends Schema.TaggedError<CrewOperationError>()(
  "CrewOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
