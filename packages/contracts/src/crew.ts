import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { BotAvatar, BotLongConversation, LEGACY_ALLOWED_TOOLS } from "./bots.ts";
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

/**
 * The tools a bot or role can hold. Agents store the ones a person withheld, so every tool here,
 * including one added later, is on unless withheld. `crew.*` grants gate the crew MCP tools; the
 * rest name T3 MCP toolkits. `botOnly` grants are for bots alone.
 */
export const CREW_TOOL_GRANTS = [
  {
    id: "crew.workflows",
    label: "Manage bots, roles and workflows",
    description: "Create and edit bots, roles and workflows when asked.",
    botOnly: true,
  },
  {
    id: "orchestration",
    label: "Threads and subagents",
    description: "Run subagents in parallel, and create, read and message T3 threads.",
  },
  {
    id: "worktree",
    label: "Worktrees",
    description: "Create git worktrees and move threads into them.",
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    description: "Read and link pull requests.",
  },
  {
    id: "preview",
    label: "Browser",
    description: "Open and drive the built-in browser.",
  },
  {
    id: "device",
    label: "Devices",
    description: "Drive iOS and Android simulators.",
  },
] as const;

/** What an agent with these withheld tools gets: every grant its kind can hold, minus those. */
export const grantedTools = (
  withheld: ReadonlyArray<string>,
  options: { readonly bot: boolean },
): ReadonlyArray<string> =>
  CREW_TOOL_GRANTS.filter(
    (grant) => (options.bot || !("botOnly" in grant)) && !withheld.includes(grant.id),
  ).map((grant) => grant.id);

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

/**
 * The linked environment a shared workflow, or a role that came with one, is managed from. Copies
 * change only there; here they can't be edited.
 */
export const LibraryOwner = Schema.Struct({ environmentId: EnvironmentId, label: Schema.String });
export type LibraryOwner = typeof LibraryOwner.Type;

/** A global role: who a lead or crew member is. Editing it never rewrites existing members. */
export const RoleConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  withheldTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  enabled: Schema.Boolean,
  revision: Schema.Int,
  /** Set on a role a shared workflow brought from another environment. */
  managedBy: Schema.optionalKey(Schema.NullOr(LibraryOwner)),
});
export type RoleConfig = typeof RoleConfig.Type;
export const RoleCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  /** Omitted, every tool on create and unchanged on update. */
  withheldTools: Schema.optionalKey(Schema.Array(Schema.String)),
  allowedTools: LEGACY_ALLOWED_TOOLS,
  modelSelection: ModelSelection,
  /** Omitted, full access on create and unchanged on update. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export const RoleUpdateInput = Schema.Struct({
  ...RoleCreateInput.fields,
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
export const WorkflowSnapshot = Schema.Struct({
  workflow: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    instructions: Schema.String,
    leadRoleId: Schema.String,
    crewRoleIds: Schema.Array(Schema.String),
    revision: Schema.Int,
  }),
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      instructions: Schema.String,
      withheldTools: Schema.optionalKey(Schema.Array(Schema.String)),
      allowedTools: LEGACY_ALLOWED_TOOLS,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
    }),
  ),
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
  /** Set on a copy shared from another environment. */
  managedBy: Schema.optionalKey(Schema.NullOr(LibraryOwner)),
});
export type WorkflowConfig = typeof WorkflowConfig.Type;
export const WorkflowCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  leadRoleId: Schema.String,
  crewRoleIds: Schema.Array(Schema.String),
});
export const WorkflowUpdateInput = Schema.Struct({
  ...WorkflowCreateInput.fields,
  expectedRevision: Schema.Int,
});
export const WorkflowDeleteInput = Schema.Struct({ id: Schema.String });

/**
 * For a role a shared workflow brings that the other environment already has, with other
 * settings: `replace` overwrites its role with this one, `keep` leaves its own in place.
 */
export const WorkflowShareRoleChoice = Schema.Literals(["replace", "keep"]);
export type WorkflowShareRoleChoice = typeof WorkflowShareRoleChoice.Type;

/** A role there with the same id as one the workflow brings, and other settings. */
export const WorkflowShareClash = Schema.Struct({ id: Schema.String, name: Schema.String });
export type WorkflowShareClash = typeof WorkflowShareClash.Type;

/**
 * A linked environment a workflow is shared with, or is being removed from. `pending` waits to
 * reach it, `clash` waits on a choice for each of `clashes`, `removing` waits to remove it there.
 */
export const WorkflowShare = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  shared: Schema.Boolean,
  state: Schema.Literals(["synced", "pending", "clash", "removing"]),
  /** When it last took this workflow's current or an earlier version; null before it ever did. */
  syncedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  clashes: Schema.Array(WorkflowShareClash),
  roleChoices: Schema.Record(Schema.String, WorkflowShareRoleChoice),
});
export type WorkflowShare = typeof WorkflowShare.Type;
export const WorkflowSharesInput = Schema.Struct({ workflowId: Schema.String });

/**
 * Shares a workflow with a linked environment, or stops. Unsharing first asks there whether open
 * features follow it, and changes nothing while they do unless `confirmed`.
 */
export const WorkflowShareSetInput = Schema.Struct({
  workflowId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
  shared: Schema.Boolean,
  roleChoices: Schema.optionalKey(Schema.Record(Schema.String, WorkflowShareRoleChoice)),
  confirmed: Schema.optionalKey(Schema.Boolean),
});
export type WorkflowShareSetInput = typeof WorkflowShareSetInput.Type;
export const WorkflowShareSetResult = Schema.Struct({
  applied: Schema.Boolean,
  /** Open features there that follow the workflow; they keep running if it's removed. */
  openFeatures: Schema.Array(Schema.Struct({ featureId: Schema.String, title: Schema.String })),
});
export type WorkflowShareSetResult = typeof WorkflowShareSetResult.Type;

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
  withheldTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  longConversation: BotLongConversation,
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
  withheldTools: Schema.optionalKey(Schema.Array(Schema.String)),
  allowedTools: LEGACY_ALLOWED_TOOLS,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  longConversation: BotLongConversation,
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
 * Where a project's manager lives and works. `remoteManager` set moves it to another
 * environment's copy and retires this copy's manager; null brings it here. `retired` notes in the
 * manager's thread here which copy's manager was retired for it.
 */
export const ProjectManagerPlacementInput = Schema.Struct({
  projectId: ProjectId,
  remoteManager: Schema.optionalKey(Schema.NullOr(ProjectRemoteManager)),
  permittedEnvironmentIds: Schema.optionalKey(Schema.NullOr(Schema.Array(EnvironmentId))),
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
