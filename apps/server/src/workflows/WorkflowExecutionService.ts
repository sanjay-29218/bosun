// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  WorkflowHandoffOutcome,
  type ProjectId,
  type WorkflowDefinition,
  type WorkflowStepEvent,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { BotHandoffService, type BotHandoffError } from "../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../bots/BotHandoffStore.ts";
import { BotStore } from "../bots/BotStore.ts";
import type { BotServiceError } from "../bots/BotService.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import { WorkflowExecutionStore, type WorkflowBindings } from "./WorkflowExecutionStore.ts";
import { WorkflowService, type WorkflowServiceError } from "./WorkflowService.ts";
import { WorkflowStore } from "./WorkflowStore.ts";
import { WorkflowTransitionError } from "./WorkflowState.ts";

type ExecutionError = WorkflowServiceError | BotServiceError | BotHandoffError;
interface WorkflowControl {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly actorId: string;
  readonly kind: "answered" | "retry" | "cancelled" | "paused" | "resumed";
  readonly text?: string;
}

export class WorkflowExecutionService extends Context.Service<
  WorkflowExecutionService,
  {
    readonly attach: (
      featureId: string,
      projectId: ProjectId,
      bindings: WorkflowBindings,
    ) => Effect.Effect<void, ExecutionError>;
    readonly reconcileFeature: (featureId: string) => Effect.Effect<void, ExecutionError>;
    readonly reconcile: () => Effect.Effect<void, ExecutionError>;
    readonly start: () => Effect.Effect<void, ExecutionError, Scope.Scope>;
    readonly control: (
      input: WorkflowControl,
    ) => Effect.Effect<WorkflowFeatureSnapshot, ExecutionError>;
  }
>()("t3/workflows/WorkflowExecutionService") {}

const key = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");
const outcomeJson = Schema.fromJsonString(WorkflowHandoffOutcome);

/** The context a stage bot receives with its task: how to report, plus the previous result. */
const buildStageContext = (
  definition: WorkflowDefinition,
  stepId: string,
  events: ReadonlyArray<WorkflowStepEvent>,
) => {
  const task = definition.steps[stepId];
  const outcomes = task?.type === "task" ? Object.keys(task.next) : [];
  const priorResult = events.findLast((event) => event.kind === "completed");
  return [
    `Workflow ${definition.name}, step ${stepId}.`,
    `Report with bots_respond: completed, summary containing ONLY JSON {"outcome":"<one of: ${outcomes.join(", ")}>","summary":"<result and evidence>"}.`,
    "Use bots_ask for questions. A final chat message does not complete this step.",
    priorResult
      ? `Previous step ${priorResult.stepId}: ${priorResult.detail?.slice(0, 2_000) ?? ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export const WorkflowExecutionServiceLive = Layer.effect(
  WorkflowExecutionService,
  Effect.gen(function* () {
    const executions = yield* WorkflowExecutionStore;
    const workflows = yield* WorkflowService;
    const store = yield* WorkflowStore;
    const bots = yield* BotStore;
    const handoffs = yield* BotHandoffStore;
    const delegation = yield* BotHandoffService;
    const engine = yield* OrchestrationEngineService;
    const lock = yield* Semaphore.make(1);

    const stopCancelledRun = (featureId: string) =>
      Effect.gen(function* () {
        const events = yield* store.listEvents(featureId);
        const lastStart = events.findLast((event) => event.kind === "started");
        const handoff = lastStart?.sourceId ? yield* handoffs.get(lastStart.sourceId) : null;
        if (handoff && !["completed", "failed", "cancelled"].includes(handoff.status)) {
          yield* delegation.cancel(handoff.id);
        }
      });
    const reconcileFeatureUnlocked = (featureId: string) =>
      Effect.gen(function* () {
        const execution = yield* executions.get(featureId);
        if (!execution || execution.settled) return;
        const copy = yield* workflows.getFeatureCopy(featureId);
        if (!copy) return;
        // Every pass either records a transition or stops. No provider activity is inferred as success.
        while (true) {
          const state = yield* workflows.getFeatureState(featureId);
          if (!state) return;
          if (state.completed || state.cancelled) {
            if (state.cancelled) yield* stopCancelledRun(featureId);
            yield* executions.update(featureId, null, true);
            return;
          }
          const stepId = state.activeStepId!;
          const step = state.steps.get(stepId)!;
          const task = copy.definition.steps[stepId];
          if (task?.type !== "task") return;
          if (step.status === "failed") return;
          const events = yield* store.listEvents(featureId);
          const eventIds = new Set(events.map((event) => event.id));
          if (step.status === "pending") {
            if (state.paused) return;
            if (
              state.executionCount >= copy.definition.defaults.maxStepExecutions &&
              step.executionId === null
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Workflow execution limit reached"),
              );
            }
            const binding = execution.bindings[task.bot];
            const source = binding ? yield* bots.getRun(binding.dispatchRunId) : null;
            if (!binding || !source)
              return yield* Effect.fail(
                new WorkflowTransitionError("Assigned dispatch run is unavailable"),
              );
            const executionId =
              step.executionId ?? `execution:${key(featureId, state.executionCount + 1, stepId)}`;
            const handoffId = `workflow:${key(featureId, executionId, step.attempt + 1)}`;
            const taskText = task.task;
            const contextText = buildStageContext(copy.definition, stepId, events);
            const reserved = yield* handoffs.get(handoffId);
            const reservedRun = reserved ? yield* bots.getRun(reserved.targetRunId) : null;
            const dispatch =
              reserved?.status === "failed" && !reservedRun
                ? delegation.retry(handoffId)
                : delegation.delegate({
                    id: handoffId,
                    sourceThreadId: source.threadId,
                    targetBotId: binding.botId,
                    projectId: execution.projectId,
                    taskText,
                    contextText,
                  });
            const result = yield* dispatch.pipe(Effect.result);
            const handoff = yield* handoffs.get(handoffId);
            const run = handoff ? yield* bots.getRun(handoff.targetRunId) : null;
            if (!handoff || !run) {
              if (result._tag === "Failure") return yield* Effect.fail(result.failure);
              return yield* Effect.fail(
                new WorkflowTransitionError("Dispatch did not create a bot run"),
              );
            }
            yield* workflows.recordTrustedEvent(featureId, {
              id: `start:${key(featureId, executionId, step.attempt + 1)}`,
              stepId,
              executionId,
              kind: "started",
              botRunId: run.id,
              outcome: null,
              sourceKind: "handoff",
              sourceId: handoffId,
              actorId: source.id,
              detail: null,
              occurredAt: handoff.createdAt,
            });
            if (result._tag === "Failure" && handoff.status === "queued") {
              yield* handoffs.transition(handoff.id, ["queued"], "failed", handoff.updatedAt, {
                lastError: "Bot thread dispatch failed; retry the step",
              });
            }
            // A provider can exit before the start event made the handoff discoverable.
            yield* delegation.refreshRun(run.id);
            yield* executions.update(featureId, null, false);
            continue;
          }
          const start = events.findLast(
            (event) => event.kind === "started" && event.botRunId === step.botRunId,
          );
          if (!start?.sourceId)
            return yield* Effect.fail(
              new WorkflowTransitionError("Active step has no dispatch receipt"),
            );
          const receipts = yield* handoffs.listReceipts(start.sourceId);
          const answerDecision = events.findLast(
            (event) =>
              event.kind === "answered" &&
              event.sourceKind === "decision" &&
              event.executionId === step.executionId &&
              event.sourceId === start.sourceId,
          );
          const liveHandoff = yield* handoffs.get(start.sourceId);
          const lastQuestion = events.findLast(
            (event) => event.kind === "question" && event.executionId === step.executionId,
          );
          const latestQuestionReceipt = receipts.findLast(
            (receipt) =>
              receipt.handoff.status === "needs-input" &&
              receipt.handoff.targetRunId === step.botRunId,
          );
          if (
            answerDecision?.detail &&
            liveHandoff?.status === "needs-input" &&
            lastQuestion &&
            latestQuestionReceipt &&
            lastQuestion.id === `receipt:${key(featureId, latestQuestionReceipt.sequence)}` &&
            events.indexOf(answerDecision) > events.indexOf(lastQuestion)
          ) {
            yield* delegation.answer(start.sourceId, answerDecision.detail);
            continue;
          }
          let advanced = false;
          const lastConsumed = receipts.findLastIndex((receipt) =>
            eventIds.has(`receipt:${key(featureId, receipt.sequence)}`),
          );
          for (const receipt of receipts.slice(lastConsumed + 1)) {
            const handoff = receipt.handoff;
            if (handoff.targetRunId !== step.botRunId) continue;
            const id = `receipt:${key(featureId, receipt.sequence)}`;
            if (eventIds.has(id)) continue;
            const current = step;
            let kind: WorkflowStepEvent["kind"];
            let detail: string | null;
            let outcome: string | null = null;
            let sourceKind: WorkflowStepEvent["sourceKind"] = "handoff";
            if (handoff.status === "needs-input" && current.status === "running") {
              kind = "question";
              detail = handoff.questionText;
            } else if (
              handoff.status === "running" &&
              current.status === "needs-input" &&
              handoff.responseText
            ) {
              kind = "answered";
              detail = handoff.responseText;
            } else if (
              handoff.status === "failed" &&
              ["running", "needs-input"].includes(current.status)
            ) {
              kind = "failed";
              detail = handoff.lastError ?? handoff.responseText;
            } else if (handoff.status === "completed" && current.status === "running") {
              const decoded = yield* Schema.decodeUnknownEffect(outcomeJson)(
                handoff.responseText,
              ).pipe(Effect.result);
              if (
                decoded._tag === "Failure" ||
                !decoded.success.summary.trim() ||
                !Object.hasOwn(task.next, decoded.success.outcome)
              ) {
                kind = "failed";
                sourceKind = "workflow";
                detail =
                  "Completed handoff has an invalid or unrouted outcome; retry the step with a structured result";
              } else {
                kind = "completed";
                detail = decoded.success.summary.trim();
                outcome = decoded.success.outcome;
              }
            } else if (
              handoff.status === "cancelled" &&
              ["running", "needs-input"].includes(current.status)
            ) {
              kind = "cancelled";
              detail = "Assigned bot handoff was cancelled";
              sourceKind = null;
            } else continue;
            yield* workflows.recordTrustedEvent(featureId, {
              id,
              stepId,
              executionId: current.executionId,
              kind,
              botRunId: null,
              outcome,
              sourceKind,
              sourceId: sourceKind === null ? null : handoff.id,
              actorId: kind === "answered" ? handoff.sourceRunId : handoff.targetRunId,
              detail,
              occurredAt: handoff.updatedAt,
            });
            advanced = true;
            break;
          }
          if (!advanced) return;
        }
      }).pipe(
        Effect.tapError((error) =>
          executions.update(featureId, String(error).slice(0, 2_000), false),
        ),
      );
    const reconcileFeature = (featureId: string) =>
      reconcileFeatureUnlocked(featureId).pipe(lock.withPermits(1));
    const reconcile = (projectId?: ProjectId) =>
      executions
        .listActive(projectId)
        .pipe(
          Effect.flatMap((ids) =>
            Effect.forEach(
              ids,
              (id) =>
                reconcileFeature(id).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Workflow reconciliation failed", { featureId: id, error }),
                  ),
                ),
              { discard: true },
            ),
          ),
        );

    return WorkflowExecutionService.of({
      control: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* workflows.getFeatureSnapshot(input.featureId, input.projectId);
          if (!snapshot)
            return yield* Effect.fail(
              new WorkflowTransitionError("Feature workflow was not found"),
            );
          const prior = yield* workflows.findRecordedEvent(input.featureId, input.requestId);
          const text = input.text?.trim() ?? null;
          if (prior) {
            if (
              prior.kind !== input.kind ||
              prior.actorId !== input.actorId ||
              (input.kind === "answered" && prior.detail !== text)
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Request ID belongs to another action"),
              );
            }
          } else {
            const step = snapshot.steps.find((item) => item.id === snapshot.activeStepId);
            if (!step)
              return yield* Effect.fail(new WorkflowTransitionError("No active workflow step"));
            let sourceId: string | null = null;
            if (input.kind === "answered") {
              if (!text || text.length > 8_000 || step.status !== "needs-input" || !step.botRunId) {
                return yield* Effect.fail(
                  new WorkflowTransitionError(
                    "The active question needs an answer of 1-8000 characters",
                  ),
                );
              }
              const handoff = yield* handoffs.getForTargetRun(step.botRunId);
              if (!handoff || handoff.projectId !== input.projectId)
                return yield* Effect.fail(
                  new WorkflowTransitionError("Question handoff is unavailable"),
                );
              sourceId = handoff.id;
            }
            yield* workflows.recordTrustedEvent(input.featureId, {
              id: input.requestId,
              stepId: step.id,
              executionId: step.executionId,
              kind: input.kind,
              botRunId: null,
              outcome: null,
              sourceKind: sourceId ? "decision" : null,
              sourceId,
              actorId: input.actorId,
              detail: input.kind === "answered" ? text : null,
              occurredAt: DateTime.formatIso(yield* DateTime.now),
            });
          }
          // Record the intent before side effects so restart replay can finish them.
          if (input.kind === "cancelled") yield* stopCancelledRun(input.featureId);
          if (input.kind === "answered" && !snapshot.executionConfigured) {
            const event = (yield* workflows.findRecordedEvent(input.featureId, input.requestId))!;
            if (event.sourceId && event.detail)
              yield* delegation.answer(event.sourceId, event.detail);
          }
          yield* reconcileFeatureUnlocked(input.featureId);
          return (yield* workflows.getFeatureSnapshot(input.featureId, input.projectId))!;
        }).pipe(lock.withPermits(1)),
      attach: (featureId, projectId, bindings) =>
        Effect.gen(function* () {
          const copy = yield* workflows.getFeatureCopy(featureId);
          if (!copy || copy.projectId !== projectId)
            return yield* Effect.fail(
              new WorkflowTransitionError(
                "Feature workflow belongs to another project or is unavailable",
              ),
            );
          if (Object.keys(bindings).length !== Object.keys(copy.definition.bots).length)
            return yield* Effect.fail(
              new WorkflowTransitionError("Every workflow bot needs one binding"),
            );
          for (const [name, assignment] of Object.entries(copy.definition.bots)) {
            const binding = bindings[name];
            const bot = binding ? yield* bots.getDefinition(binding.botId) : null;
            const source = binding ? yield* bots.getRun(binding.dispatchRunId) : null;
            const sourceBot = source ? yield* bots.getDefinition(source.botId) : null;
            if (
              !binding ||
              !bot?.enabled ||
              !sourceBot?.enabled ||
              !source ||
              bot.projectId !== projectId ||
              source.projectId !== projectId ||
              (assignment.template.kind === "template"
                ? bot.featureId !== featureId ||
                  bot.templateId !== assignment.template.id ||
                  bot.templateRevision !== assignment.template.revision
                : bot.id !== assignment.template.id || bot.featureId !== null) ||
              !source.allowedTools.includes("bots.delegate") ||
              !bot.allowedTools.includes("bots.respond") ||
              (assignment.supervisor !== null &&
                source.botId !== bindings[assignment.supervisor]?.botId) ||
              !(yield* bots.canDelegate(source.botId, bot.id))
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError(`Unauthorized or mismatched workflow binding: ${name}`),
              );
            }
          }
          yield* executions.attach(featureId, bindings);
          const persisted = yield* executions.get(featureId);
          if (
            !persisted ||
            Object.entries(bindings).some(
              ([name, binding]) =>
                persisted.bindings[name]?.botId !== binding.botId ||
                persisted.bindings[name]?.dispatchRunId !== binding.dispatchRunId,
            )
          ) {
            return yield* Effect.fail(
              new WorkflowTransitionError("Workflow is already bound to another crew"),
            );
          }
          yield* reconcileFeature(featureId);
        }),
      reconcileFeature,
      reconcile: () => reconcile(),
      start: () =>
        Effect.gen(function* () {
          const handoffChanges = yield* handoffs.subscribeChanges;
          const workflowChanges = yield* store.subscribeChanges;
          const domainEvents = engine.streamDomainEvents;
          yield* Stream.runForEach(handoffChanges, (id) =>
            executions.findFeatureForHandoff(id).pipe(
              Effect.flatMap((featureId) =>
                featureId ? reconcileFeature(featureId) : Effect.void,
              ),
              Effect.catch((error) =>
                Effect.logWarning("Workflow handoff reconciliation failed", { error }),
              ),
            ),
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(workflowChanges, (id) =>
            reconcileFeature(id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Workflow control reconciliation failed", { error }),
              ),
            ),
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(domainEvents, (event) => {
            if (event.type !== "run.updated") return Effect.void;
            return handoffs.getRunByThread(event.payload.threadId).pipe(
              Effect.flatMap((runId) =>
                runId ? handoffs.getForTargetRun(runId) : Effect.succeed(null),
              ),
              Effect.flatMap((handoff) =>
                handoff
                  ? executions
                      .findFeatureForHandoff(handoff.id)
                      .pipe(
                        Effect.flatMap((featureId) =>
                          featureId
                            ? delegation
                                .refreshRun(handoff.targetRunId)
                                .pipe(Effect.andThen(reconcileFeature(featureId)))
                            : Effect.void,
                        ),
                      )
                  : Effect.void,
              ),
              Effect.catch((error) =>
                Effect.logWarning("Workflow provider reconciliation failed", { error }),
              ),
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Workflow orchestration stream failed", { error }),
            ),
            Effect.forkScoped,
          );
          yield* reconcile();
        }),
    });
  }),
);
