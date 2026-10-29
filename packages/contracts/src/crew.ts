import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Crew mode: global Roles (planner, designer, builder, reviewer, project manager...) and the
 * crew members a project or feature instantiates from them. Runs and handoffs are the durable
 * work those members do. "Bot" is reserved for the top-level bots that own projects.
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
export const CrewTurnStateSchema = Schema.Literals([
  CREW_TURN_STATE.MISSING,
  CREW_TURN_STATE.PENDING,
  CREW_TURN_STATE.RUNNING,
  CREW_TURN_STATE.COMPLETED,
  CREW_TURN_STATE.INTERRUPTED,
  CREW_TURN_STATE.ERROR,
]);

export const CREW_DISPATCH_STATE = {
  QUEUED: "queued",
  STARTED: "started",
} as const;
export type CrewDispatchState = (typeof CREW_DISPATCH_STATE)[keyof typeof CREW_DISPATCH_STATE];
export const CrewDispatchStateSchema = Schema.Literals([
  CREW_DISPATCH_STATE.QUEUED,
  CREW_DISPATCH_STATE.STARTED,
]);

/** The global role every project's manager is made from, which Captain delegates to. */
export const PROJECT_MANAGER_ROLE_ID = "role:project-manager";

/**
 * The tools a bot or role can be granted. `crew.*` grants gate the crew MCP tools one by one;
 * the rest each unlock a whole T3 MCP toolkit for the run. `botOnly` grants act on the
 * projects a bot owns, so role editors leave them out.
 */
export const CREW_TOOL_GRANTS = [
  {
    id: "crew.delegate",
    label: "Delegate work",
    description: "Hand tasks to the project manager or another crew member.",
  },
  {
    id: "crew.status",
    label: "Follow handoffs",
    description: "List and wait on work it handed off.",
  },
  {
    id: "crew.answer",
    label: "Answer questions",
    description: "Reply when work it handed off asks a question.",
  },
  {
    id: "crew.ask",
    label: "Ask questions",
    description: "Ask whoever handed it work for a decision.",
  },
  {
    id: "crew.respond",
    label: "Report results",
    description: "Send its finished outcome back to whoever asked.",
  },
  {
    id: "crew.projects",
    label: "See its projects",
    description: "List the projects a bot owns, with their managers and features.",
    botOnly: true,
  },
  {
    id: "crew.create-project",
    label: "Create projects",
    description: "Start a new project it owns, from a name or by cloning a Git URL.",
    botOnly: true,
  },
  {
    id: "crew.workflows",
    label: "Manage workflows",
    description:
      "Create and edit bots, workflows and roles, and start features on them, when asked.",
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

export const CrewRunSummary = Schema.Struct({
  id: Schema.String,
  memberId: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  dispatchState: CrewDispatchStateSchema,
  turnState: CrewTurnStateSchema,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type CrewRunSummary = typeof CrewRunSummary.Type;

export const CrewHandoff = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
  targetMemberId: Schema.String,
  targetRunId: Schema.String,
  projectId: ProjectId,
  taskText: Schema.String,
  contextText: Schema.String,
  depth: Schema.Int,
  status: Schema.Literals(["queued", "running", "completed", "needs-input", "failed", "cancelled"]),
  responseText: Schema.NullOr(Schema.String),
  questionText: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CrewHandoff = typeof CrewHandoff.Type;

export const CrewProjectInput = Schema.Struct({ projectId: ProjectId });
export const CrewProjectSnapshot = Schema.Struct({
  members: Schema.Array(CrewMemberSummary),
  runs: Schema.Array(CrewRunSummary),
  handoffs: Schema.Array(CrewHandoff),
});
export type CrewProjectSnapshot = typeof CrewProjectSnapshot.Type;

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
export const CrewHandoffActionInput = Schema.Struct({
  projectId: ProjectId,
  requestId: Schema.String,
  text: Schema.optional(Schema.String),
});

export class CrewOperationError extends Schema.TaggedError<CrewOperationError>()(
  "CrewOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
