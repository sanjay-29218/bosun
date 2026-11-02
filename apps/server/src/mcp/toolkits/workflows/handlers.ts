import {
  OrchestratorMcpFailure,
  type FeatureWorkspace,
  type RoleCreateInput,
  type RoleUpdateInput,
  type WorkflowCreateInput,
  type WorkflowReviseInput,
  workflowForwardStages,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { CrewService } from "../../../crew/CrewService.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { asWorkflowManager, fullAccessCaller } from "./access.ts";
import { WorkflowsToolkit } from "./tools.ts";

/** Bot and crew threads need the grant to read the library; everyone else may. */
const checkRead = asWorkflowManager(Effect.void);

/** Every caller that isn't a bot or crew thread needs full access to change the library. */
const checkWrite = asWorkflowManager(
  fullAccessCaller(
    "Changing workflows and roles needs a live full-access/default calling thread or a full-access client.",
  ),
);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
/** Passes service errors on as messages an agent can act on. */
const asMcpFailure = (error: unknown) =>
  isMcpFailure(error) ? error : invalid(error instanceof Error ? error.message : String(error));

/** Runs `effect` after `check`. */
const guarded =
  <EC, RC>(check: Effect.Effect<void, EC, RC>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    check.pipe(Effect.andThen(effect), Effect.mapError(asMcpFailure));
const reading = guarded(checkRead);
const writing = guarded(checkWrite);

const make = Effect.gen(function* () {
  const workflows = yield* WorkflowService;
  const crew = yield* CrewService;
  const features = yield* FeatureService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  return {
    t3_workflow_list: McpToolAccess.reads(() =>
      workflows.listLatestDefinitions().pipe(
        Effect.mapError(asMcpFailure),
        Effect.map((definitions) => ({
          workflows: definitions.map((definition) => ({
            id: definition.id,
            name: definition.name,
            revision: definition.revision,
            stages: workflowForwardStages(definition),
          })),
        })),
      ),
    ),
    t3_workflow_get: McpToolAccess.reads((input: { readonly id: string }) =>
      workflows.getLatestDefinition(input.id).pipe(
        Effect.filterOrFail(Predicate.isNotNull, () =>
          invalid(`Workflow not found: ${input.id}. t3_workflow_list shows the library.`),
        ),
        Effect.mapError(asMcpFailure),
      ),
    ),
    t3_workflow_create: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowCreateInput.Type) =>
        writing(workflows.createDefinition(input.definition)),
    ),
    t3_workflow_update: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowReviseInput.Type) =>
        writing(workflows.reviseDefinition(input.definition, input.expectedRevision)),
    ),
    t3_workflow_delete: McpToolAccess.writesWithCapability((input: { readonly id: string }) =>
      writing(workflows.deleteDefinition(input.id)).pipe(Effect.as({ deleted: true })),
    ),
    t3_role_list: McpToolAccess.reads(() =>
      reading(crew.listRoles()).pipe(Effect.map((roles) => ({ roles }))),
    ),
    t3_role_create: McpToolAccess.writesWithCapability((input: typeof RoleCreateInput.Type) =>
      writing(crew.createRole(input)),
    ),
    t3_role_update: McpToolAccess.writesWithCapability((input: typeof RoleUpdateInput.Type) =>
      writing(crew.updateRole(input)),
    ),
    t3_feature_start: McpToolAccess.actsAsCaller(
      (input: {
        readonly projectId?: string | undefined;
        readonly title: string;
        readonly brief: string;
        readonly workflowId?: string | undefined;
        readonly featureId?: string | undefined;
        readonly workspace?: FeatureWorkspace | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_start",
          );
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          if (input.projectId !== undefined && input.projectId !== shell.projectId) {
            return yield* invalid(
              "A feature starts in this thread's own project. To start work in another project, hand it a task with delegate_task and target.projectId.",
            );
          }
          const { feature, snapshot } = yield* features.launch({
            ...input,
            projectId: shell.projectId,
          });
          return {
            featureId: feature.id,
            projectId: feature.projectId,
            title: feature.title,
            workflowId: snapshot.definition.id,
            workflowRevision: snapshot.definition.revision,
            state: snapshot.state ?? null,
            stage: snapshot.activeStepId,
            threadId:
              snapshot.steps.find((step) => step.id === snapshot.activeStepId)?.threadId ?? null,
          };
        }).pipe(Effect.mapError(asMcpFailure)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(WorkflowsToolkit, make);
