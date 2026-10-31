import {
  FeatureCardState,
  OrchestratorMcpFailure,
  RoleConfig,
  FeatureWorkspace,
  RoleCreateInput,
  RoleUpdateInput,
  ThreadId,
  WorkflowCreateInput,
  WorkflowDefinition,
  WorkflowReviseInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { CrewService } from "../../../crew/CrewService.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    WorkflowService,
    CrewService,
    FeatureService,
  ],
};

const WorkflowSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  /** Task steps in the order a feature moves through them by default. */
  stages: Schema.Array(Schema.String),
});

const ListWorkflows = Tool.make("t3_workflow_list", {
  ...shared,
  description:
    "List the environment's workflows: the global library features start from, also shown in the app's Library. t3_workflow_get returns one in full.",
  success: Schema.Struct({ workflows: Schema.Array(WorkflowSummary) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GetWorkflow = Tool.make("t3_workflow_get", {
  ...shared,
  description:
    "Read a workflow's full definition. `roles` maps each workflow role key to a global role (roleId, pinned roleRevision) and the role key that supervises it. `steps` maps step ids to tasks: the role key that performs it, its task text, `next` (outcome → next step id), and `gate: true` to wait for a person's approval. Exactly one step is `{ type: \"end\" }`.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: WorkflowDefinition,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CreateWorkflow = Tool.make("t3_workflow_create", {
  ...shared,
  description:
    'Create a workflow in the shape t3_workflow_get returns, with schemaVersion 2 and revision 1. Copying an existing workflow is the easiest start. Give each stage a role key in `roles`, pinning the roleId and current revision from t3_role_list; only enabled roles that can run stages qualify, plus "role:project-manager", which usually supervises the rest. Step and role keys are lowercase ids; every step must be reachable from `start` and lead to the end step. Set defaults to { questions: "supervisor", failure: "pause", maxStepExecutions: 30 } unless asked otherwise.',
  parameters: WorkflowCreateInput,
  success: WorkflowDefinition,
});

const UpdateWorkflow = Tool.make("t3_workflow_update", {
  ...shared,
  description:
    "Change a workflow: read it with t3_workflow_get, edit the definition, and send all of it back with expectedRevision set to the revision you read and definition.revision one higher. Rename it, add, remove or reorder stages by rewiring `next`, change a stage's role, or toggle `gate`. Drop `layout` entries for removed steps; new steps are placed on the canvas automatically. Features already running stay on the revision they started with. A bot's default workflow is set with t3_bot_update.",
  parameters: WorkflowReviseInput,
  success: WorkflowDefinition,
});

const DeleteWorkflow = Tool.make("t3_workflow_delete", {
  ...shared,
  description:
    "Delete a workflow. Refused while an unfinished feature runs on it or a bot starts its features with it; the error names them.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
}).annotate(Tool.Destructive, true);

const ListRoles = Tool.make("t3_role_list", {
  ...shared,
  description:
    "List the global roles (job descriptions) workflows assign to stages, with each one's current revision, also shown in the app's Library.",
  success: Schema.Struct({ roles: Schema.Array(RoleConfig) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CreateRole = Tool.make("t3_role_create", {
  ...shared,
  description:
    'Create a role. Choose an id like "role:qa-tester". Set autoCreateForFeature to let it run workflow stages, and grant "crew.respond" and "crew.ask" so it can report its outcome and ask questions. Copy modelSelection and runtimeMode from an existing role unless asked otherwise.',
  parameters: RoleCreateInput,
  success: RoleConfig,
});

const UpdateRole = Tool.make("t3_role_update", {
  ...shared,
  description:
    "Change a role: send every field back, edited, with expectedRevision set to the revision from t3_role_list. Roles are not deleted; set enabled to false to retire one, and true to bring it back. Each edit raises the role's revision, and workflows pin revisions, so afterwards re-pin roleRevision with t3_workflow_update in the workflows that use it or their new features won't start. The project manager role is exempt: workflows follow its current revision.",
  parameters: RoleUpdateInput,
  success: RoleConfig,
});

const StartFeature = Tool.make("t3_feature_start", {
  ...shared,
  description:
    "Start a feature in this thread's project: create it from a short title and a brief (the task, up to 16,000 characters) and run it on a workflow (t3_workflow_list). Omit workflowId for the project's default. The feature works in its own new worktree and branch; set workspace to local only when the person asks to work in the project's checkout. threadId is the current stage's thread, null while it waits for an agent slot. Retrying with the same featureId, yours or the one an error names, never starts a second feature.",
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.String),
    title: Schema.String,
    brief: Schema.String,
    workflowId: Schema.optional(Schema.String),
    featureId: Schema.optional(Schema.String),
    workspace: Schema.optional(FeatureWorkspace),
  }),
  success: Schema.Struct({
    featureId: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    workflowId: Schema.String,
    workflowRevision: Schema.Int,
    state: Schema.NullOr(FeatureCardState),
    stage: Schema.NullOr(Schema.String),
    threadId: Schema.NullOr(ThreadId),
  }),
}).annotate(Tool.Destructive, false);

export const WorkflowsToolkit = Toolkit.make(
  ListWorkflows,
  GetWorkflow,
  CreateWorkflow,
  UpdateWorkflow,
  DeleteWorkflow,
  ListRoles,
  CreateRole,
  UpdateRole,
  StartFeature,
);
