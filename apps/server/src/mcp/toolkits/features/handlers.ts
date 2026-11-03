import {
  OrchestratorMcpFailure,
  ProjectId,
  type FeatureWorkspace,
  type RoleCreateInput,
  type RoleUpdateInput,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CrewService } from "../../../crew/CrewService.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { asCrewManager, fullAccessCaller } from "./access.ts";
import { FeaturesToolkit } from "./tools.ts";

/** Bot and crew threads need the grant to read roles; everyone else may. */
const checkRead = asCrewManager(Effect.void);

/** Every caller that isn't a bot or crew thread needs full access to change the Library. */
const checkWrite = asCrewManager(
  fullAccessCaller(
    "Changing roles or workflows needs a live full-access/default calling thread or a full-access client.",
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
  const crew = yield* CrewService;
  const features = yield* FeatureService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  return {
    t3_role_list: McpToolAccess.reads(() =>
      reading(Effect.all({ roles: crew.listRoles(), workflows: crew.listWorkflows() })),
    ),
    t3_role_create: McpToolAccess.writesWithCapability((input: typeof RoleCreateInput.Type) =>
      writing(crew.createRole(input)),
    ),
    t3_role_update: McpToolAccess.writesWithCapability((input: typeof RoleUpdateInput.Type) =>
      writing(crew.updateRole(input)),
    ),
    t3_feature_workflow_create: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowCreateInput.Type) => writing(crew.createWorkflow(input)),
    ),
    t3_feature_workflow_update: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowUpdateInput.Type) => writing(crew.updateWorkflow(input)),
    ),
    t3_feature_start: McpToolAccess.actsAsCaller(
      (input: {
        readonly projectId?: string | undefined;
        readonly title: string;
        readonly brief: string;
        readonly featureId?: string | undefined;
        readonly workspace?: FeatureWorkspace | undefined;
        readonly workflowId?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_start",
          );
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          if (input.projectId !== undefined && input.projectId !== shell.projectId) {
            yield* fullAccessCaller(
              "Starting a feature in another project needs a live full-access/default calling thread.",
            );
          }
          const { feature, leadThreadId } = yield* features.launch({
            ...input,
            projectId:
              input.projectId === undefined ? shell.projectId : ProjectId.make(input.projectId),
          });
          return {
            featureId: feature.id,
            projectId: feature.projectId,
            title: feature.title,
            leadThreadId,
          };
        }).pipe(Effect.mapError(asMcpFailure)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(FeaturesToolkit, make);
