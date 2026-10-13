import {
  type AuthSessionId,
  BotOperationError,
  CrewOperationError,
  BosunWsRpcGroup,
  FeatureOperationError,
  WorkflowOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BotService } from "./bots/BotService.ts";
import type { CrewHandoffService } from "./crew/CrewHandoffService.ts";
import type { CrewHandoffStore } from "./crew/CrewHandoffStore.ts";
import type { CrewService } from "./crew/CrewService.ts";
import type { CrewStore } from "./crew/CrewStore.ts";
import type { FeatureService } from "./features/FeatureService.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import type {
  WorkflowControl,
  WorkflowExecutionService,
} from "./workflows/WorkflowExecutionService.ts";
import type { WorkflowService } from "./workflows/WorkflowService.ts";

const isCrewOperationError = Schema.is(CrewOperationError);

export interface BosunWsServices {
  readonly bots: BotService["Service"];
  readonly crew: CrewService["Service"];
  readonly crewStore: CrewStore["Service"];
  readonly crewHandoffs: CrewHandoffService["Service"];
  readonly crewHandoffStore: CrewHandoffStore["Service"];
  readonly features: FeatureService["Service"];
  readonly workflows: WorkflowService["Service"];
  readonly workflowExecution: WorkflowExecutionService["Service"];
}

/**
 * Handlers for Bosun's features, workflows, roles and crew RPCs, merged with the T3
 * handlers in `ws.ts`. A separate group keeps the T3 handler map within the
 * type checker's instantiation depth and keeps upstream merges cheap.
 */
export const layerBosunWsRpc = (
  {
    bots,
    crew,
    crewStore,
    crewHandoffs,
    crewHandoffStore,
    features,
    workflows,
    workflowExecution,
  }: BosunWsServices,
  currentSessionId: AuthSessionId,
) =>
  BosunWsRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const control = (input: Omit<WorkflowControl, "actorId">) =>
        workflowExecution
          .control({ ...input, actorId: currentSessionId })
          .pipe(Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })));
      return {
        [WS_METHODS.featuresSetStatus]: (input) =>
          features
            .setStatus(input.featureId, input.projectId, input.status)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresCreate]: (input) =>
          features
            .create(input)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresList]: (input) =>
          features
            .listByProject(input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresBoard]: (input) =>
          features
            .board(input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresGet]: (input) =>
          Effect.gen(function* () {
            const feature = yield* features.get(input.featureId);
            return feature?.projectId === input.projectId ? feature : null;
          }).pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsList]: () =>
          workflows
            .listLatestDefinitions()
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsEnsureStarter]: () =>
          workflows
            .ensureStarterDefinition()
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsValidate]: (input) =>
          workflows
            .validateDefinition(input.definition)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsCreate]: (input) =>
          workflows
            .createDefinition(input.definition)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsRevise]: (input) =>
          workflows
            .reviseDefinition(input.definition, input.expectedRevision)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsGetFeature]: (input) =>
          workflows
            .getFeatureSnapshot(input.featureId, input.projectId)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsGetStageHandoff]: (input) =>
          workflows
            .getStageHandoffForThread(input.projectId, input.threadId)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsAnswer]: (input) =>
          workflowExecution
            .control({
              ...input,
              actorId: currentSessionId,
              kind: "answered",
              text: input.text,
            })
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsRetry]: (input) => control({ ...input, kind: "retry" }),
        [WS_METHODS.workflowsApprove]: ({ note, ...input }) =>
          control({ ...input, kind: "approved", ...(note === undefined ? {} : { text: note }) }),
        [WS_METHODS.workflowsRequestChanges]: ({ note, ...input }) =>
          control({ ...input, kind: "changes-requested", text: note }),
        [WS_METHODS.workflowsTakeOver]: (input) => control({ ...input, kind: "taken-over" }),
        [WS_METHODS.workflowsMarkDone]: ({ summary, ...input }) =>
          control({ ...input, kind: "marked-done", text: summary }),
        [WS_METHODS.workflowsSendBack]: ({ note, ...input }) =>
          control({ ...input, kind: "sent-back", ...(note === undefined ? {} : { text: note }) }),
        [WS_METHODS.workflowsSkip]: (input) => control({ ...input, kind: "skipped" }),
        [WS_METHODS.workflowsAcceptAsIs]: (input) => control({ ...input, kind: "accepted" }),
        [WS_METHODS.workflowsOneMoreRound]: (input) => control({ ...input, kind: "extended" }),
        [WS_METHODS.workflowsStartNow]: (input) =>
          workflowExecution
            .startNow(input.featureId, input.projectId)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.featuresStart]: (input) =>
          features
            .start(input.featureId, input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresReopen]: (input) =>
          features
            .reopen({
              id: input.featureId,
              projectId: input.projectId,
              requestId: input.requestId,
              actorId: currentSessionId,
              ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
            })
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresAttachThread]: (input) =>
          features
            .attachThread({ ...input, actorId: currentSessionId })
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresDetachThread]: (input) =>
          features
            .detachThread({ ...input, actorId: currentSessionId })
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresThreadLink]: (input) =>
          features
            .threadLink(input.projectId, input.threadId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsCancel]: (input) =>
          workflowExecution
            .control({
              ...input,
              actorId: currentSessionId,
              kind: "cancelled",
            })
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsPause]: (input) =>
          workflowExecution
            .control({
              ...input,
              actorId: currentSessionId,
              kind: "paused",
            })
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsResume]: (input) =>
          workflowExecution
            .control({
              ...input,
              actorId: currentSessionId,
              kind: "resumed",
            })
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.botsList]: () =>
          bots.list.pipe(
            Effect.mapError((error) => new BotOperationError({ reason: error.message })),
          ),
        [WS_METHODS.botsCreate]: (input) =>
          bots
            .create(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsUpdate]: (input) =>
          bots
            .update(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsDelete]: (input) =>
          bots
            .delete(input.id)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsReorder]: (input) =>
          bots
            .reorder(input.botIds)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsMoveProject]: (input) =>
          bots
            .moveProject(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.rolesList]: () =>
          crew
            .listRoles()
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.rolesCreate]: (input) =>
          crew
            .createRole(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.rolesUpdate]: (input) =>
          crew
            .updateRole(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewSnapshot]: (input) =>
          Effect.gen(function* () {
            yield* crewHandoffs.refreshProject(input.projectId);
            const project = yield* projectStore.getShell(input.projectId);
            if (Option.isNone(project)) {
              return yield* new CrewOperationError({ reason: "Project not found" });
            }
            const [members, runs, handoffs] = yield* Effect.all([
              crewStore.listMembersForProject(input.projectId),
              crew.listRunSummaries(input.projectId, 50),
              crewHandoffStore.listByProject(input.projectId, 100),
            ]);
            return { members, runs, handoffs };
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewConfiguration]: (input) =>
          Effect.gen(function* () {
            const project = yield* projectStore.getShell(input.projectId);
            if (Option.isNone(project)) {
              return yield* new CrewOperationError({ reason: "Project not found" });
            }
            const [hierarchy, delegationGrants] = yield* Effect.all([
              crew.listHierarchyForProject(input.projectId),
              crew.listDelegationGrantsForProject(input.projectId),
            ]);
            return { hierarchy, delegationGrants };
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewInitialize]: (input) =>
          crew
            .ensureDefaults(input.modelSelection)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewInstantiate]: (input) =>
          crew
            .instantiate(input.id, input.projectId, input.roleId)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewSetHierarchy]: (input) =>
          Effect.gen(function* () {
            const child = yield* crew.getMember(input.memberId);
            if (child?.projectId !== input.projectId) {
              return yield* new CrewOperationError({ reason: "Crew member not found in project" });
            }
            yield* crew.setHierarchyParent(input.memberId, input.parentMemberId, input.position);
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewSetDelegation]: (input) =>
          Effect.gen(function* () {
            const target = yield* crew.getMember(input.targetMemberId);
            if (target?.projectId !== input.projectId) {
              return yield* new CrewOperationError({ reason: "Crew member not found in project" });
            }
            if (input.allowed) {
              yield* crew.allowDelegation(input.sourceMemberId, input.targetMemberId);
            } else {
              yield* crew.revokeDelegation(input.sourceMemberId, input.targetMemberId);
            }
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewStart]: (input) =>
          crew.startRequest(input).pipe(
            Effect.map((run) => ({ runId: run.id, threadId: run.threadId })),
            Effect.mapError((error) => new CrewOperationError({ reason: String(error) })),
          ),
        [WS_METHODS.crewAnswer]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* crewHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new CrewOperationError({ reason: "Handoff not found in project" });
            }
            if (!input.text) return yield* new CrewOperationError({ reason: "Answer is required" });
            return yield* crewHandoffs.answer(input.requestId, input.text);
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewCancel]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* crewHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new CrewOperationError({ reason: "Handoff not found in project" });
            }
            return yield* crewHandoffs.cancel(input.requestId);
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.crewRetry]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* crewHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new CrewOperationError({ reason: "Handoff not found in project" });
            }
            return yield* crewHandoffs.retry(input.requestId);
          }).pipe(
            Effect.mapError((error) =>
              isCrewOperationError(error)
                ? error
                : new CrewOperationError({ reason: String(error) }),
            ),
          ),
      };
    }),
  );
