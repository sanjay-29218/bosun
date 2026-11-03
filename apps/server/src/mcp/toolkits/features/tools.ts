import {
  FeatureWorkspace,
  OrchestratorMcpFailure,
  RoleConfig,
  RoleCreateInput,
  RoleUpdateInput,
  ThreadId,
  WorkflowConfig,
  WorkflowCreateInput,
  WorkflowUpdateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { CrewService } from "../../../crew/CrewService.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CrewService,
    FeatureService,
  ],
};

const ListRoles = Tool.make("t3_role_list", {
  ...shared,
  description:
    "List the Library: the global roles (who a lead or crew member is) and the workflows features follow (a lead role, its crew roles and instructions), each with its current revision.",
  success: Schema.Struct({
    roles: Schema.Array(RoleConfig),
    workflows: Schema.Array(WorkflowConfig),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CreateRole = Tool.make("t3_role_create", {
  ...shared,
  description:
    'Create a role. Choose an id like "role:qa-tester". Add it to a workflow\'s crewRoleIds so features on that workflow get a member of it. Copy modelSelection and runtimeMode from an existing role unless asked otherwise.',
  parameters: RoleCreateInput,
  success: RoleConfig,
});

const UpdateRole = Tool.make("t3_role_update", {
  ...shared,
  description:
    "Change a role: send every field back, edited, with expectedRevision set to the revision from t3_role_list. Roles are not deleted; set enabled to false to retire one, and true to bring it back. Features already started keep the crew they were given.",
  parameters: RoleUpdateInput,
  success: RoleConfig,
});

const CreateWorkflow = Tool.make("t3_feature_workflow_create", {
  ...shared,
  description:
    'Create a workflow features can follow. Choose an id like "workflow:social-media". leadRoleId is the role that leads it and crewRoleIds the roles it hands work to, from t3_role_list. instructions say how the lead runs the work, in plain steps.',
  parameters: WorkflowCreateInput,
  success: WorkflowConfig,
});

const UpdateWorkflow = Tool.make("t3_feature_workflow_update", {
  ...shared,
  description:
    "Change a workflow: send every field back, edited, with expectedRevision set to the revision from t3_role_list. Features already started keep the workflow text and crew they started with.",
  parameters: WorkflowUpdateInput,
  success: WorkflowConfig,
});

const StartFeature = Tool.make("t3_feature_start", {
  ...shared,
  description:
    "Start a feature in projectId, or this thread's project when omitted (full access is required to target another project), from a short title and a brief (the task, up to 16,000 characters). It follows workflowId (Feature delivery when omitted; t3_role_list shows the others): the workflow's lead gets its instructions and the brief in a new thread and runs its crew. The feature works in its own new worktree and branch; set workspace to local only when the person asks to work in the project's checkout. Retrying with the same featureId, yours or the one an error names, never starts a second feature.",
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.String),
    title: Schema.String,
    brief: Schema.String,
    featureId: Schema.optional(Schema.String),
    workspace: Schema.optional(FeatureWorkspace),
    workflowId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    featureId: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    leadThreadId: ThreadId,
  }),
}).annotate(Tool.Destructive, false);

export const FeaturesToolkit = Toolkit.make(
  ListRoles,
  CreateRole,
  UpdateRole,
  CreateWorkflow,
  UpdateWorkflow,
  StartFeature,
);
