import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Crew mode: global Roles (planner, designer, builder, reviewer, project manager...) and the
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

/** The global role every project's manager is made from, which Captain delegates to. */
export const PROJECT_MANAGER_ROLE_ID = "role:project-manager";

/**
 * The tools a bot or role can be granted. `crew.*` grants gate the crew MCP tools one by one.
 * The rest name T3 MCP toolkits: a run gets every toolkit an ordinary thread gets, and naming
 * any limits it to those. `botOnly` grants are for bots, so role editors leave them out.
 */
export const CREW_TOOL_GRANTS = [
  {
    id: "crew.decide",
    label: "Decide for features",
    description: "Approve gates and answer questions of the feature stages it leads.",
  },
  {
    id: "crew.respond",
    label: "Report results",
    description: "Report a workflow stage's outcome, or a question for a person.",
  },
  {
    id: "crew.workflows",
    label: "Manage workflows",
    description: "Create and edit bots, workflows and roles when asked.",
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

/** A global role. Workflows pin a role's revision; editing it never rewrites existing members. */
export const RoleConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  enabled: Schema.Boolean,
  /** The role can run workflow stages, and joins features started without a workflow. */
  autoCreateForFeature: Schema.Boolean,
  revision: Schema.Int,
});
export type RoleConfig = typeof RoleConfig.Type;
export const RoleCreateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  autoCreateForFeature: Schema.Boolean,
});
export const RoleUpdateInput = Schema.Struct({
  ...RoleCreateInput.fields,
  expectedRevision: Schema.Int,
  enabled: Schema.Boolean,
});
/** Creates the default roles that are missing, using `modelSelection` for each. */
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

export const CrewStartInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  taskText: Schema.String,
});
export const CrewStartResult = Schema.Struct({
  runId: Schema.String,
  threadId: ThreadId,
});
export class CrewOperationError extends Schema.TaggedError<CrewOperationError>()(
  "CrewOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
