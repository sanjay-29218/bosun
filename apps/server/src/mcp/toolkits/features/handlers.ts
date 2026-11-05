import {
  headquartersBotId,
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
        readonly baseBranch?: string | undefined;
        readonly parentFeatureId?: null | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_start",
          );
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          // A bot's headquarters lives outside its projects, so it may start features in the ones
          // it owns; anyone else needs full access to reach another project.
          if (input.projectId !== undefined && input.projectId !== shell.projectId) {
            const botId = headquartersBotId(scope.thread.threadId);
            const owner =
              botId === null ? null : yield* features.projectBot(ProjectId.make(input.projectId));
            if (botId === null || owner !== botId) {
              yield* fullAccessCaller(
                "Starting a feature in another project needs a live full-access/default calling thread, or the headquarters of the bot that owns it.",
              );
            }
          }
          const { parentFeatureId: _parent, ...request } = input;
          const { feature, leadThreadId, branch } = yield* features.launch({
            ...request,
            projectId:
              input.projectId === undefined ? shell.projectId : ProjectId.make(input.projectId),
            // A feature's thread starts its feature's children, which report to their parent's
            // lead, unless it asks for no parent; any other starter hears from the lead each time
            // it stops.
            ...(shell.feature && input.parentFeatureId === undefined
              ? { parentFeatureId: shell.feature.id }
              : {
                  // A subagent, such as a bot's project manager, has already reported back; its
                  // top thread is the one to keep posted.
                  requesterThreadId:
                    shell.lineage.relationshipToParent === "subagent"
                      ? shell.lineage.rootThreadId
                      : scope.thread.threadId,
                }),
          });
          return {
            featureId: feature.id,
            projectId: feature.projectId,
            title: feature.title,
            leadThreadId,
            branch,
            parentFeatureId: feature.parentFeatureId ?? null,
          };
        }).pipe(Effect.mapError(asMcpFailure)),
    ),
    t3_feature_finish: McpToolAccess.actsAsCaller((input: { readonly summary: string }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadScope(
          yield* McpInvocationContext.McpInvocationContext,
          "t3_feature_finish",
        );
        const feature = yield* features.finishForThread(scope.thread.threadId, input.summary);
        return { featureId: feature.id, parentFeatureId: feature.parentFeatureId ?? null };
      }).pipe(Effect.mapError(asMcpFailure)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(FeaturesToolkit, make);
