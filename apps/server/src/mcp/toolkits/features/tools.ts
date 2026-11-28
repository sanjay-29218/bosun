import {
  FeatureWorkspace,
  EnvironmentId,
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
    "List the Library: global roles (who a crew member is) and the workflows features follow (lead instructions and crew roles), with their revisions.",
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
    'Create a role with an id like "role:qa-tester"; add it to a workflow\'s crewRoleIds to give its features a member of it. Copy modelSelection from an existing role unless asked otherwise. Members get every tool and full access.',
  parameters: RoleCreateInput,
  success: RoleConfig,
});

const UpdateRole = Tool.make("t3_role_update", {
  ...shared,
  description:
    "Change a role: send every field back, edited, with expectedRevision from t3_role_list. Roles aren't deleted: enabled false retires one, true restores it. alsoUpdateOn: importers that also take this save; replacesEdits only if the person agreed. Started features keep their crew.",
  parameters: RoleUpdateInput,
  success: RoleConfig,
});

const CreateWorkflow = Tool.make("t3_feature_workflow_create", {
  ...shared,
  description:
    'Create a workflow features can follow, with an id like "workflow:social-media". crewRoleIds: the roles it hands work to (t3_role_list). instructions: how each feature\'s lead runs the work, in plain steps.',
  parameters: WorkflowCreateInput,
  success: WorkflowConfig,
});

const UpdateWorkflow = Tool.make("t3_feature_workflow_update", {
  ...shared,
  description:
    "Change a workflow: send every field back, edited, with expectedRevision from t3_role_list. alsoUpdateOn as for roles. Started features keep the text and crew they started with.",
  parameters: WorkflowUpdateInput,
  success: WorkflowConfig,
});

const ImportLibrary = Tool.make("t3_library_import", {
  ...shared,
  description:
    "A linked environment's roles and workflows. No ids: list them and what importing would do. roleIds/workflowIds: import them or take updates (a workflow brings missing roles); mode: replace overwrites ours (ask first); keep stops following; skip skips the update.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    roleIds: Schema.optional(Schema.Array(Schema.String)),
    workflowIds: Schema.optional(Schema.Array(Schema.String)),
    mode: Schema.optional(Schema.Literals(["replace", "keep", "skip"])),
  }),
  success: Schema.Struct({
    listed: Schema.optional(LibraryImportable),
    imported: Schema.optional(LibraryImportResult),
    /** mode keep: how many are this environment's own now. */
    kept: Schema.optional(Schema.Number),
    /** mode skip: how many had their current update skipped. */
    updatesSkipped: Schema.optional(Schema.Number),
  }),
}).annotate(Tool.Destructive, false);

const StartFeature = Tool.make("t3_feature_start", {
  ...shared,
  dependencies: [...shared.dependencies, RemoteDelegation.RemoteDelegation],
  description:
    "Start a feature from a short title and a brief (the task, up to 16,000 characters) in projectId (default: this thread's project; another needs full access). It follows workflowId (default Feature delivery; t3_role_list lists others): its lead gets the workflow's instructions and the brief in a new thread and runs its crew, in a new worktree and branch from baseBranch (an existing branch, such as another feature's, to stack on) or else the project's current branch; workspace local only when the person asks to work in the project's checkout. From a feature's thread it is that feature's child and reports to its lead when done; set parentFeatureId null when that feature doesn't need this work to count as finished. Otherwise the lead's words come back to this thread each time it stops with its crew idle. Retrying with the same featureId (yours, or one an error names) never starts a second. A headquarters passes environmentId for its bot's project on a linked environment, a project's manager for its project's copy there (only projectId, title, brief, issue and featureId; a manager may add baseBranch, a branch there, and requestId): a task there starts it, waiting while that environment is offline.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description:
          "A linked environment where your bot owns the project or your project has a copy (t3_bot_projects). Omit for this one.",
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
          "Omitted, a feature's thread starts a child of its own feature. Managers: a feature of this project to add it under. null: a separate feature, reporting back to this thread.",
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
    "Report the feature you lead done, its pull request open if the project has a remote: the board shows it ready for review, and whoever started it (or a child's parent lead, with branch and pull request) gets your summary. Call it once the work is done, not for progress, and again after asked-for changes.",
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
  description: "This project's features, newest first. Filter by status or parentFeatureId.",
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
  StartFeature,
  FinishFeature,
  ListFeatures,
);
