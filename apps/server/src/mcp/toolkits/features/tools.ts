import {
  FeatureWorkspace,
  EnvironmentId,
  LibraryDetachInput,
  LibraryImportable,
  LibraryImportResult,
  OrchestratorMcpFailure,
  NodeId,
  RoleConfig,
  RoleCreateInput,
  RoleUpdateInput,
  ThreadId,
  WorkflowConfig,
  WorkflowCreateInput,
  WorkflowUpdateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { CrewService } from "../../../crew/CrewService.ts";
import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CrewService,
    FeatureService,
    ProjectRequests,
  ],
};

/** Where an imported one stands, worked out for agents. */
const importState = {
  edited: Schema.Boolean,
  updateAvailable: Schema.Boolean,
};

const ListRoles = Tool.make("t3_role_list", {
  ...shared,
  description:
    "List the Library: the global roles (who a crew member is) and the workflows features follow (instructions for the lead, and its crew roles), each with its current revision. importedFrom names the linked environment one was imported from, edited says it changed here since, and updateAvailable that its source has a newer one (t3_library_import takes it). importers lists the environments that imported one from here.",
  success: Schema.Struct({
    roles: Schema.Array(Schema.Struct({ ...RoleConfig.fields, ...importState })),
    workflows: Schema.Array(Schema.Struct({ ...WorkflowConfig.fields, ...importState })),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CreateRole = Tool.make("t3_role_create", {
  ...shared,
  description:
    'Create a role. Choose an id like "role:qa-tester". Add it to a workflow\'s crewRoleIds so features on that workflow get a member of it. Copy modelSelection from an existing role unless asked otherwise. Its members get every tool, with full access.',
  parameters: RoleCreateInput,
  success: RoleConfig,
});

const UpdateRole = Tool.make("t3_role_update", {
  ...shared,
  description:
    "Change a role: send every field back, edited, with expectedRevision set to the revision from t3_role_list. Roles are not deleted; set enabled to false to retire one, and true to bring it back. fallbackModelSelection runs when its model can't (null clears it, and the Settings fallback model is used). alsoUpdateOn: importers' environmentIds that take this change too, replacing their edits. Features already started keep the crew they were given.",
  parameters: RoleUpdateInput,
  success: RoleConfig,
});

const CreateWorkflow = Tool.make("t3_feature_workflow_create", {
  ...shared,
  description:
    'Create a workflow features can follow. Choose an id like "workflow:social-media". crewRoleIds are the roles it hands work to, from t3_role_list. instructions say how the lead of each feature runs the work, in plain steps.',
  parameters: WorkflowCreateInput,
  success: WorkflowConfig,
});

const UpdateWorkflow = Tool.make("t3_feature_workflow_update", {
  ...shared,
  description:
    "Change a workflow: send every field back, edited, with expectedRevision set to the revision from t3_role_list. alsoUpdateOn: importers' environmentIds that take this change too, replacing their edits. Features already started keep the workflow text and crew they started with.",
  parameters: WorkflowUpdateInput,
  success: WorkflowConfig,
});

const ImportLibrary = Tool.make("t3_library_import", {
  ...shared,
  description:
    "Import roles and workflows from a linked environment. With no ids, lists what it has and what each would do here (new, update, current, or replaces one here). With ids, imports them; a workflow brings the roles it names that are missing here. Importing one already imported from there takes its update. One that would replace a role or workflow here is skipped unless replace is true; ask the person first.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    roleIds: Schema.optional(Schema.Array(Schema.String)),
    workflowIds: Schema.optional(Schema.Array(Schema.String)),
    replace: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    listed: Schema.optional(LibraryImportable),
    imported: Schema.optional(LibraryImportResult),
  }),
}).annotate(Tool.Destructive, false);

const DetachLibrary = Tool.make("t3_library_detach", {
  ...shared,
  description:
    'For an imported role or workflow: mode "detach" keeps it as this environment\'s own and stops showing its source\'s updates; mode "skip" hides the update available now until a newer one.',
  parameters: LibraryDetachInput,
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, false);

const StartFeature = Tool.make("t3_feature_start", {
  ...shared,
  dependencies: [...shared.dependencies, RemoteDelegation.RemoteDelegation],
  description:
    "Start a feature in projectId, or this thread's project when omitted (full access is required to target another project), from a short title and a brief (the task, up to 16,000 characters). It follows workflowId (Feature delivery when omitted; t3_role_list shows the others): its lead gets the workflow's instructions and the brief in a new thread and runs its crew. The feature works in its own new worktree and branch, made from baseBranch when set (an existing branch, such as another feature's, to stack on it) and otherwise from the project's current branch; set workspace to local only when the person asks to work in the project's checkout. Started from a feature's thread, the new feature is that feature's child by default: its lead reports back to that feature's lead when it finishes. When that feature doesn't need this work done to count as finished, set parentFeatureId to null: the new feature stands on its own. Started with no parent, or from any other thread, each time the lead stops with its crew idle, what it said comes back to this thread. Retrying with the same featureId, yours or the one an error names, never starts a second feature. A headquarters passes environmentId for its bot's project on a linked environment, and a project's manager for its project's copy there (with only projectId, title, brief, issue and featureId; a manager may add baseBranch, a branch there, and requestId): a task there starts it, and if that environment is offline, it waits and starts by itself when it's back.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description:
          "A linked environment where your bot owns the project, or your project has a copy (t3_bot_projects). Omit for this one.",
      }),
    ),
    projectId: Schema.optional(Schema.String),
    title: Schema.String,
    brief: Schema.String,
    featureId: Schema.optional(Schema.String),
    workspace: Schema.optional(FeatureWorkspace),
    workflowId: Schema.optional(Schema.String),
    baseBranch: Schema.optional(Schema.String),
    requestId: Schema.optional(
      Schema.String.annotate({
        description: "Managers: the request (R-n) it answers.",
      }),
    ),
    issue: Schema.optional(
      Schema.String.annotate({
        description: "Its issue: a link, `#56` or `T-14`.",
      }),
    ),
    parentFeatureId: Schema.optional(
      Schema.NullOr(Schema.String).annotate({
        description:
          "Omit it and a feature's thread starts a child of its own feature. Managers: a feature of this project to add it under. null: a separate feature with no parent, which reports back to this thread.",
      }),
    ),
  }),
  success: Schema.Struct({
    featureId: Schema.NullOr(Schema.String).annotate({
      description: "Null on a linked environment, where a task starts it.",
    }),
    projectId: Schema.String,
    title: Schema.String,
    leadThreadId: Schema.NullOr(ThreadId),
    branch: Schema.NullOr(Schema.String),
    parentFeatureId: Schema.NullOr(Schema.String),
    taskId: Schema.optional(NodeId),
    link: Schema.optional(Schema.NullOr(Schema.String)),
    waiting: Schema.optional(
      Schema.String.annotate({
        description: "Set while its environment is offline; don't start it again.",
      }),
    ),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const FinishFeature = Tool.make("t3_feature_finish", {
  ...shared,
  description:
    "Report that the feature you lead is done, its pull request open if the project has a remote. The board shows it ready for review, and whoever started it, or a child's parent lead with its branch and pull request, gets your summary. Call it once the work is done, not for progress, and again after asked-for changes.",
  parameters: Schema.Struct({
    summary: Schema.String.annotate({
      description: "What the feature changed, what was checked, and anything left open.",
    }),
  }),
  success: Schema.Struct({
    featureId: Schema.String,
    parentFeatureId: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ListFeatures = Tool.make("t3_feature_list", {
  ...shared,
  description:
    "This project's features, newest first: lead thread, branches, parent, issue, pull request and state, requester, request, and last report. Filter by status or parentFeatureId.",
  parameters: Schema.Struct({
    status: Schema.optional(Schema.Literals(["open", "closed"])),
    parentFeatureId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    features: Schema.Array(
      Schema.Struct({
        featureId: Schema.String,
        number: Schema.optional(Schema.Number),
        title: Schema.String,
        status: Schema.Literals(["open", "closed"]),
        leadThreadId: Schema.NullOr(ThreadId),
        branch: Schema.NullOr(Schema.String),
        baseBranch: Schema.NullOr(Schema.String),
        parentFeatureId: Schema.NullOr(Schema.String),
        issue: Schema.NullOr(Schema.Struct({ ref: Schema.String, title: Schema.String })),
        pullRequest: Schema.NullOr(
          Schema.Struct({
            url: Schema.String,
            number: Schema.Number,
            state: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])),
          }),
        ),
        requesterThreadId: Schema.NullOr(Schema.String),
        requestId: Schema.NullOr(Schema.String),
        report: Schema.NullOr(
          Schema.Literals(["finished", "closed", "stopped", "failed", "interrupted"]),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const FeaturesToolkit = Toolkit.make(
  ListRoles,
  CreateRole,
  UpdateRole,
  CreateWorkflow,
  UpdateWorkflow,
  ImportLibrary,
  DetachLibrary,
  StartFeature,
  FinishFeature,
  ListFeatures,
);
