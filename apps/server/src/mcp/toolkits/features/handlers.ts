import {
  headquartersBotId,
  headquartersProjectId,
  type ThreadId,
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
import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
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

/** A request ID is the caller's own: a project's manager naming a request of its project. */
const requireOwnRequest = Effect.fn("FeaturesToolkit.requireOwnRequest")(function* (
  callerThreadId: ThreadId,
  targetProjectId: string | undefined,
  requestId: string,
) {
  const projectId = headquartersProjectId(callerThreadId);
  if (projectId === null || (targetProjectId !== undefined && targetProjectId !== projectId)) {
    return yield* invalid("Only a project's manager names a request, for work in its project.");
  }
  const requests = yield* ProjectRequests;
  if ((yield* requests.get(projectId, requestId)) === null) {
    return yield* invalid(`This project has no request ${requestId}.`);
  }
});

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
        readonly requestId?: string | undefined;
        readonly issue?: string | undefined;
        readonly parentFeatureId?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_start",
          );
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          const requestId = input.requestId?.trim() || undefined;
          if (requestId !== undefined) {
            yield* requireOwnRequest(scope.thread.threadId, input.projectId, requestId);
          }
          // A feature's own threads start its children; a project's manager may add one to any
          // feature of its project, such as a follow-up to an Epic.
          const namedParent = input.parentFeatureId?.trim() || undefined;
          if (namedParent !== undefined) {
            const managed = headquartersProjectId(scope.thread.threadId);
            const parent = managed === null ? null : yield* features.get(namedParent);
            if (
              managed === null ||
              (input.projectId !== undefined && input.projectId !== managed)
            ) {
              return yield* invalid(
                "Only a project's manager names a parent feature, in its own project. A feature's threads start its children without one.",
              );
            }
            if (parent === null || parent.projectId !== managed) {
              return yield* invalid(`This project has no feature ${namedParent}.`);
            }
          }
          const parentFeatureId = namedParent ?? shell.feature?.id;
          if (input.projectId === undefined && headquartersBotId(scope.thread.threadId) !== null) {
            return yield* invalid(
              "Pass projectId: your home isn't a project. t3_bot_projects lists your projects.",
            );
          }
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
          const { feature, leadThreadId, branch } = yield* features.launch({
            ...input,
            requestId,
            projectId:
              input.projectId === undefined ? shell.projectId : ProjectId.make(input.projectId),
            // A child reports to its parent's lead; any other feature to the thread that started
            // it, each time its lead stops.
            ...(parentFeatureId !== undefined
              ? { parentFeatureId }
              : {
                  // A subagent, such as a bot's delegated task, has already reported back; its
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
    t3_feature_list: McpToolAccess.reads(
      (input: {
        readonly status?: "open" | "closed" | undefined;
        readonly parentFeatureId?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_list",
          );
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          return {
            features: yield* features.list(shell.projectId, {
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.parentFeatureId === undefined
                ? {}
                : { parentFeatureId: input.parentFeatureId }),
            }),
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
