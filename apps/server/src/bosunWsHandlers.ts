import {
  type AuthSessionId,
  BotOperationError,
  BosunWsRpcGroup,
  FeatureOperationError,
  WorkflowOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BotHandoffService } from "./bots/BotHandoffService.ts";
import type { BotHandoffStore } from "./bots/BotHandoffStore.ts";
import type { BotService } from "./bots/BotService.ts";
import type { BotStore } from "./bots/BotStore.ts";
import type { FeatureService } from "./features/FeatureService.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import type { WorkflowExecutionService } from "./workflows/WorkflowExecutionService.ts";
import type { WorkflowService } from "./workflows/WorkflowService.ts";

const isBotOperationError = Schema.is(BotOperationError);

export interface BosunWsServices {
  readonly bots: BotService["Service"];
  readonly botStore: BotStore["Service"];
  readonly botHandoffs: BotHandoffService["Service"];
  readonly botHandoffStore: BotHandoffStore["Service"];
  readonly features: FeatureService["Service"];
  readonly workflows: WorkflowService["Service"];
  readonly workflowExecution: WorkflowExecutionService["Service"];
}

/**
 * Handlers for Bosun's features, workflows and bots RPCs, merged with the T3
 * handlers in `ws.ts`. A separate group keeps the T3 handler map within the
 * type checker's instantiation depth and keeps upstream merges cheap.
 */
export const layerBosunWsRpc = (
  {
    bots,
    botStore,
    botHandoffs,
    botHandoffStore,
    features,
    workflows,
    workflowExecution,
  }: BosunWsServices,
  currentSessionId: AuthSessionId,
) =>
  BosunWsRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const projectStore = yield* ProjectStore.ProjectStoreV2;
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
        [WS_METHODS.featuresGet]: (input) =>
          Effect.gen(function* () {
            const feature = yield* features.get(input.featureId);
            return feature?.projectId === input.projectId ? feature : null;
          }).pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsList]: (input) =>
          workflows
            .listLatestDefinitions(input.projectId)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsEnsureStarter]: (input) =>
          workflows
            .ensureStarterDefinition(input.projectId)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsValidate]: (input) =>
          workflows
            .validateDefinition(input.projectId, input.definition)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsCreate]: (input) =>
          workflows
            .createDefinition(input.projectId, input.definition)
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
        [WS_METHODS.workflowsRevise]: (input) =>
          workflows
            .reviseDefinition(input.projectId, input.definition, input.expectedRevision)
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
        [WS_METHODS.workflowsRetry]: (input) =>
          workflowExecution
            .control({
              ...input,
              actorId: currentSessionId,
              kind: "retry",
            })
            .pipe(
              Effect.mapError((error) => new WorkflowOperationError({ reason: String(error) })),
            ),
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
        [WS_METHODS.botsSnapshot]: (input) =>
          Effect.gen(function* () {
            yield* botHandoffs.refreshProject(input.projectId);
            const project = yield* projectStore.getShell(input.projectId);
            if (Option.isNone(project)) {
              return yield* new BotOperationError({ reason: "Project not found" });
            }
            const [definitions, runs, handoffs] = yield* Effect.all([
              botStore.listDefinitionsForProject(input.projectId),
              bots.listRunSummaries(input.projectId, 50),
              botHandoffStore.listByProject(input.projectId, 100),
            ]);
            return { definitions, runs, handoffs };
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsConfiguration]: (input) =>
          Effect.gen(function* () {
            const project = yield* projectStore.getShell(input.projectId);
            if (Option.isNone(project)) {
              return yield* new BotOperationError({ reason: "Project not found" });
            }
            const [templates, hierarchy, delegationGrants] = yield* Effect.all([
              bots.listTemplatesForProject(input.projectId),
              bots.listHierarchyForProject(input.projectId),
              bots.listDelegationGrantsForProject(input.projectId),
            ]);
            return { templates, hierarchy, delegationGrants };
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsInitialize]: (input) =>
          bots.ensureCrew(input.projectId, input.modelSelection).pipe(
            Effect.asVoid,
            Effect.mapError((error) => new BotOperationError({ reason: String(error) })),
          ),
        [WS_METHODS.botsCreateTemplate]: (input) =>
          bots
            .createTemplate(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: String(error) }))),
        [WS_METHODS.botsUpdateTemplate]: (input) =>
          bots
            .updateTemplate(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: String(error) }))),
        [WS_METHODS.botsInstantiate]: (input) =>
          bots
            .instantiate(input.id, input.projectId, input.templateId)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: String(error) }))),
        [WS_METHODS.botsSetHierarchy]: (input) =>
          Effect.gen(function* () {
            const child = yield* bots.getDefinition(input.botId);
            if (child?.projectId !== input.projectId) {
              return yield* new BotOperationError({ reason: "Bot not found in project" });
            }
            yield* bots.setHierarchyParent(input.botId, input.parentBotId, input.position);
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsSetDelegation]: (input) =>
          Effect.gen(function* () {
            const target = yield* bots.getDefinition(input.targetBotId);
            if (target?.projectId !== input.projectId) {
              return yield* new BotOperationError({ reason: "Bot not found in project" });
            }
            if (input.allowed) {
              yield* bots.allowDelegation(input.sourceBotId, input.targetBotId);
            } else {
              yield* bots.revokeDelegation(input.sourceBotId, input.targetBotId);
            }
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsStart]: (input) =>
          Effect.gen(function* () {
            yield* bots.ensureCrew(input.projectId, input.modelSelection);
            const run = yield* bots.createRun({
              id: input.id,
              botId: "bot-captain",
              projectId: input.projectId,
              taskText: `Project: ${input.projectId}. Manager bot: bot-manager:${input.projectId}. Person's request: ${input.taskText}`,
              modelSelection: input.modelSelection,
            });
            return { runId: run.id, threadId: run.threadId };
          }).pipe(Effect.mapError((error) => new BotOperationError({ reason: String(error) }))),
        [WS_METHODS.botsAnswer]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* botHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new BotOperationError({ reason: "Handoff not found in project" });
            }
            if (!input.text) return yield* new BotOperationError({ reason: "Answer is required" });
            return yield* botHandoffs.answer(input.requestId, input.text);
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsCancel]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* botHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new BotOperationError({ reason: "Handoff not found in project" });
            }
            return yield* botHandoffs.cancel(input.requestId);
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
        [WS_METHODS.botsRetry]: (input) =>
          Effect.gen(function* () {
            const handoff = yield* botHandoffs.get(input.requestId);
            if (handoff?.projectId !== input.projectId) {
              return yield* new BotOperationError({ reason: "Handoff not found in project" });
            }
            return yield* botHandoffs.retry(input.requestId);
          }).pipe(
            Effect.mapError((error) =>
              isBotOperationError(error) ? error : new BotOperationError({ reason: String(error) }),
            ),
          ),
      };
    }),
  );
