import {
  type EnvironmentId,
  headquartersBotId,
  headquartersProjectId,
  libraryImportState,
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

import { LibraryImports } from "../../../crew/LibraryImports.ts";
import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { sendToLinkedProject } from "../bots/linkedRequest.ts";
import { fullAccessCaller } from "./access.ts";
import { FeaturesToolkit } from "./tools.ts";

/** Changing the Library needs full access, from any caller. */
const checkWrite = fullAccessCaller(
  "Changing roles or workflows needs a live full-access/default calling thread or a full-access client.",
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
const reading = guarded(Effect.void);
const withImportState = <T extends Parameters<typeof libraryImportState>[0]>(
  items: ReadonlyArray<T>,
) => items.map((item) => ({ ...item, ...libraryImportState(item) }));
const writing = guarded(checkWrite);

/**
 * A feature for a headquarters' project, or a manager's project's copy, on a linked environment,
 * which a task there starts.
 */
const startOnLinkedEnvironment = Effect.fn("FeaturesToolkit.startOnLinkedEnvironment")(function* (
  callerThreadId: ThreadId,
  environmentId: EnvironmentId,
  input: {
    readonly projectId?: string | undefined;
    readonly title: string;
    readonly brief: string;
    readonly featureId?: string | undefined;
    readonly issue?: string | undefined;
    readonly workspace?: FeatureWorkspace | undefined;
    readonly workflowId?: string | undefined;
    readonly baseBranch?: string | undefined;
    readonly requestId?: string | undefined;
    readonly parentFeatureId?: string | null | undefined;
  },
) {
  if (input.projectId === undefined) {
    return yield* invalid(
      "Pass projectId with environmentId: t3_bot_projects lists your projects there.",
    );
  }
  // A project's manager also names the base branch, which resolves there, and its own request.
  const manager = headquartersProjectId(callerThreadId) !== null;
  if (
    input.workspace !== undefined ||
    input.workflowId !== undefined ||
    (!manager && (input.baseBranch !== undefined || input.requestId !== undefined)) ||
    input.parentFeatureId !== undefined
  ) {
    return yield* invalid(
      manager
        ? "With environmentId, pass only projectId, title, brief, issue, baseBranch, requestId and featureId; the task there picks the rest."
        : "With environmentId, pass only projectId, title, brief, issue and featureId; the task there picks the rest.",
    );
  }
  const requestId = input.requestId?.trim() || undefined;
  if (requestId !== undefined) yield* requireOwnRequest(callerThreadId, undefined, requestId);
  const issue = input.issue?.trim() || undefined;
  const baseBranch = input.baseBranch?.trim() || undefined;
  const sent = yield* sendToLinkedProject("t3_feature_start", {
    environmentId,
    projectId: ProjectId.make(input.projectId),
    // The request lives here, so its task here names it; what comes back is labelled with it.
    title: requestId === undefined ? input.title : `${requestId}: ${input.title}`,
    request: `Start a feature with t3_feature_start for this request, titled "${input.title}"${issue === undefined ? "" : `, with its issue ${issue}`}${baseBranch === undefined ? "" : `, with baseBranch "${baseBranch}" (a branch of this checkout)`}:\n\n${input.brief}`,
    key: `feature-start:${input.featureId ?? input.title}`,
  });
  return {
    featureId: null,
    projectId: input.projectId,
    title: input.title,
    leadThreadId: sent.threadId,
    branch: null,
    parentFeatureId: null,
    taskId: sent.taskId,
    link: sent.link,
    ...(sent.waiting === null ? {} : { waiting: sent.waiting }),
  };
});

const make = Effect.gen(function* () {
  const library = yield* LibraryImports;
  const features = yield* FeatureService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  return {
    t3_role_list: McpToolAccess.reads(() =>
      reading(
        Effect.all({
          roles: library.listRoles.pipe(Effect.map(withImportState)),
          workflows: library.listWorkflows.pipe(Effect.map(withImportState)),
        }),
      ),
    ),
    t3_role_create: McpToolAccess.writesWithCapability((input: typeof RoleCreateInput.Type) =>
      writing(library.createRole(input)),
    ),
    t3_role_update: McpToolAccess.writesWithCapability((input: typeof RoleUpdateInput.Type) =>
      writing(library.updateRole(input)),
    ),
    t3_feature_workflow_create: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowCreateInput.Type) => writing(library.createWorkflow(input)),
    ),
    t3_feature_workflow_update: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowUpdateInput.Type) => writing(library.updateWorkflow(input)),
    ),
    t3_library_import: McpToolAccess.writesWithCapability(
      (input: {
        readonly environmentId: EnvironmentId;
        readonly roleIds?: ReadonlyArray<string> | undefined;
        readonly workflowIds?: ReadonlyArray<string> | undefined;
        readonly mode?: "replace" | "keep" | "skip" | undefined;
      }) =>
        Effect.gen(function* () {
          // A role and a workflow may share an id, so each list names its kind.
          const roleIds = input.roleIds ?? [];
          const workflowIds = input.workflowIds ?? [];
          const mode = input.mode;
          if (mode === "keep" || mode === "skip") {
            const items = [
              ...roleIds.map((id) => ({ kind: "role" as const, id })),
              ...workflowIds.map((id) => ({ kind: "workflow" as const, id })),
            ];
            for (const item of items) {
              yield* writing(
                library.detach({ ...item, mode: mode === "keep" ? "detach" : "skip" }),
              );
            }
            return mode === "keep" ? { kept: items.length } : { updatesSkipped: items.length };
          }
          if (roleIds.length + workflowIds.length === 0) {
            return { listed: yield* reading(library.importable(input.environmentId)) };
          }
          const imported = yield* writing(
            library.importItems({
              sourceEnvironmentId: input.environmentId,
              roleIds,
              workflowIds,
              replace: mode === "replace",
            }),
          );
          return { imported };
        }),
    ),
    t3_feature_start: McpToolAccess.actsAsCaller(
      (input: {
        readonly environmentId?: EnvironmentId | undefined;
        readonly projectId?: string | undefined;
        readonly title: string;
        readonly brief: string;
        readonly featureId?: string | undefined;
        readonly workspace?: FeatureWorkspace | undefined;
        readonly workflowId?: string | undefined;
        readonly baseBranch?: string | undefined;
        readonly requestId?: string | undefined;
        readonly issue?: string | undefined;
        readonly parentFeatureId?: string | null | undefined;
      }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_feature_start",
          );
          const environmentId = PeerForwarding.remoteTarget(scope, input.environmentId);
          if (environmentId !== undefined)
            return yield* startOnLinkedEnvironment(scope.thread.threadId, environmentId, input);
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell === null) return yield* invalid("This thread has no project");
          const requestId = input.requestId?.trim() || undefined;
          if (requestId !== undefined) {
            yield* requireOwnRequest(scope.thread.threadId, input.projectId, requestId);
          }
          // A feature's own threads start its children unless they ask for none (null); a
          // project's manager may add one to any feature of its project, such as an Epic's.
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
          const parentFeatureId =
            input.parentFeatureId === null ? undefined : (namedParent ?? shell.feature?.id);
          if (input.projectId === undefined && headquartersBotId(scope.thread.threadId) !== null) {
            return yield* invalid(
              "Pass projectId: your home isn't a project. t3_bot_projects lists your projects.",
            );
          }
          // Its lead and crew run with full access, so only a caller that has it may start one.
          yield* fullAccessCaller(
            "Starting a feature needs a live full-access/default calling thread: its lead and crew run with full access.",
          );
          const { parentFeatureId: _parent, ...request } = input;
          const { feature, leadThreadId, branch } = yield* features.launch({
            ...request,
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
