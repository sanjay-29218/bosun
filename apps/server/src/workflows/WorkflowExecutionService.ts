// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  CrewStageSummary,
  WorkflowHandoffOutcome,
  type ModelSelection,
  type ProjectId,
  type ServerSettingsError,
  type ThreadId,
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
import { ServerSettingsService } from "../serverSettings.ts";
import { WorkflowExecutionStore, type WorkflowBindings } from "./WorkflowExecutionStore.ts";
import { renderStageHandoff } from "./StageHandoff.ts";
import { stageThreadSummaries } from "./CrewStageThreads.ts";
import { WorkflowService, type WorkflowServiceError } from "./WorkflowService.ts";
import { WorkflowStore } from "./WorkflowStore.ts";
import {
  defaultForwardOutcome,
  featureCardState,
  WorkflowTransitionError,
  type WorkflowState,
  type WorkflowStepState,
} from "./WorkflowState.ts";

export type WorkflowExecutionError = ExecutionError;
type ExecutionError =
  | WorkflowServiceError
  | BotServiceError
  | BotHandoffError
  | ServerSettingsError;

/** A person's (or agent's) decision on a feature, recorded under its request ID. */
export interface WorkflowControl {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly actorId: string;
  readonly kind:
    | "answered"
    | "retry"
    | "cancelled"
    | "paused"
    | "resumed"
    | "approved"
    | "changes-requested"
    | "taken-over"
    | "marked-done"
    | "skipped"
    | "sent-back"
    | "reopened"
    | "accepted"
    | "extended";
  /** The answer, gate note, send-back note or Mark done summary. */
  readonly text?: string;
  /** Mark done's result; Skip and Accept as is default to the first unlimited route. */
  readonly outcome?: string;
  /** Send back's target, or the stage a follow-up from Done starts at. */
  readonly stepId?: string;
  /** Retry with another model. */
  readonly modelSelection?: ModelSelection;
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
    /** Starts a queued feature's stage now, ignoring the running-thread limits once. */
    readonly startNow: (
      featureId: string,
      projectId: ProjectId,
    ) => Effect.Effect<WorkflowFeatureSnapshot, ExecutionError>;
  }
>()("t3/workflows/WorkflowExecutionService") {}

const key = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");
const outcomeJson = Schema.fromJsonString(WorkflowHandoffOutcome);
const encodeStageSummary = Schema.encodeSync(Schema.fromJsonString(CrewStageSummary));

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
    const settings = yield* ServerSettingsService;
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
    /**
     * Takes a stage slot, or queues the feature first in, first out. Slots count running stage
     * threads only, environment-wide and per provider instance; a person's threads never count.
     */
    const acquireSlot = (featureId: string, instanceId: string, ignoreLimit: boolean) =>
      Effect.gen(function* () {
        const { crew } = yield* settings.getSettings;
        const slots = yield* executions.listSlots();
        const mine = slots.find((slot) => slot.featureId === featureId);
        if (mine && mine.queuedAt === null && mine.slotInstanceId !== null) return true;
        const holding = slots.filter((slot) => slot.queuedAt === null && slot.slotInstanceId);
        const caps = new Map(Object.entries(crew.providerLimits));
        const fits = (instance: string) =>
          holding.length < crew.maxRunningStageThreads &&
          holding.filter((slot) => slot.slotInstanceId === instance).length <
            (caps.get(instance) ?? Number.POSITIVE_INFINITY);
        const queuedAt = mine?.queuedAt ?? DateTime.formatIso(yield* DateTime.now);
        const earlierFits = slots.some(
          (slot) =>
            slot.featureId !== featureId &&
            slot.queuedAt !== null &&
            slot.slotInstanceId !== null &&
            (slot.queuedAt < queuedAt ||
              (slot.queuedAt === queuedAt && slot.featureId < featureId)) &&
            fits(slot.slotInstanceId),
        );
        if (ignoreLimit || (fits(instanceId) && !earlierFits)) {
          yield* executions.setSlot(featureId, null, instanceId);
          return true;
        }
        yield* executions.setSlot(featureId, queuedAt, instanceId);
        return false;
      });

    /** Records an automatic retry while the stage has retries left. */
    const applyFailurePolicy = (
      featureId: string,
      definition: WorkflowDefinition,
      step: WorkflowStepState,
      events: ReadonlyArray<WorkflowStepEvent>,
    ) =>
      Effect.gen(function* () {
        const failure = events.findLast(
          (event) =>
            event.kind === "failed" &&
            event.stepId === step.id &&
            event.executionId === step.executionId,
        );
        if (!failure) return false;
        const used = events.filter(
          (event) =>
            event.kind === "retry" &&
            event.sourceKind === "workflow" &&
            event.stepId === step.id &&
            event.executionId === step.executionId,
        ).length;
        const allowed =
          definition.defaults.retries ?? (yield* settings.getSettings).crew.stageRetries;
        if (used >= allowed) return false;
        yield* workflows.recordTrustedEvent(featureId, {
          id: `auto-retry:${key(featureId, failure.id)}`,
          stepId: step.id,
          executionId: step.executionId,
          kind: "retry",
          botRunId: null,
          outcome: null,
          sourceKind: "workflow",
          sourceId: failure.id,
          actorId: "workflow",
          detail: null,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
        });
        return true;
      });

    const advance = (featureId: string, ignoreLimit: boolean) =>
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
          const events = yield* store.listEvents(featureId);
          if (step.status === "failed") {
            if (yield* applyFailurePolicy(featureId, copy.definition, step, events)) continue;
            return;
          }
          // Gates, Your call and taken-over stages wait for a person.
          if (!["pending", "running", "needs-input"].includes(step.status)) return;
          const eventIds = new Set(events.map((event) => event.id));
          if (step.status === "pending") {
            if (state.paused) return;
            const binding = execution.bindings[task.bot];
            const source = binding ? yield* bots.getRun(binding.dispatchRunId) : null;
            const bot = binding ? yield* bots.getDefinition(binding.botId) : null;
            if (!binding || !source || !bot)
              return yield* Effect.fail(
                new WorkflowTransitionError("Assigned dispatch run is unavailable"),
              );
            const instanceId = (step.modelSelection ?? bot.modelSelection).instanceId;
            if (!(yield* acquireSlot(featureId, instanceId, ignoreLimit))) return;
            const executionId =
              step.executionId ?? `execution:${key(featureId, state.executionCount + 1, stepId)}`;
            const handoffId = `workflow:${key(featureId, executionId, step.attempt + 1)}`;
            // The stage starts from its persisted handoff record and nothing else.
            const { taskText, contextText } = renderStageHandoff(
              yield* workflows.prepareStageHandoff({
                featureId,
                stepId,
                executionId,
                attempt: step.attempt + 1,
                handoffId,
              }),
            );
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
                    ...(step.modelSelection ? { modelSelection: step.modelSelection } : {}),
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
      });

    /** A feature holds its slot only while a stage thread runs; anything else frees it. */
    const syncSlot = (featureId: string): Effect.Effect<void, ExecutionError> =>
      Effect.gen(function* () {
        const execution = yield* executions.get(featureId);
        if (!execution) return;
        const state = yield* workflows.getFeatureState(featureId);
        const step = state?.activeStepId ? state.steps.get(state.activeStepId) : undefined;
        const holding = execution.queuedAt === null && execution.slotInstanceId !== null;
        if (!execution.settled && step?.status === "running") {
          if (holding) return;
          // An answered question resumes past the limit; count it so new stages wait.
          const run = step.botRunId ? yield* bots.getRun(step.botRunId) : null;
          if (run) yield* executions.setSlot(featureId, null, run.modelSelection.instanceId);
          return;
        }
        if (!execution.settled && state?.readyStepIds.length && execution.queuedAt !== null) return;
        if (execution.queuedAt === null && execution.slotInstanceId === null) return;
        yield* executions.setSlot(featureId, null, null);
        if (holding) yield* drainQueue(featureId);
      });

    /**
     * Writes each stage thread's board summary onto its thread shell. A thread that fails to
     * update keeps its old row, so the next reconcile retries it. The first write also gives the
     * thread the feature's title, since the thread is the feature's sidebar row.
     */
    const syncStageThreads = (featureId: string): Effect.Effect<void, ExecutionError> =>
      Effect.gen(function* () {
        const copy = yield* workflows.getFeatureCopy(featureId);
        const state = yield* workflows.getFeatureState(featureId);
        if (!copy || !state) return;
        const events = yield* store.listEvents(featureId);
        const execution = yield* executions.get(featureId);
        const runThreads = new Map<string, ThreadId>();
        for (const event of events) {
          if (event.kind !== "started" || !event.botRunId || runThreads.has(event.botRunId))
            continue;
          const run = yield* bots.getRun(event.botRunId);
          if (run) runThreads.set(run.id, run.threadId);
        }
        const written = yield* executions.listStageThreads(featureId);
        const title = execution?.brief?.title.trim() || null;
        const summaries = stageThreadSummaries({
          featureId,
          definition: copy.definition,
          events,
          state: featureCardState(state, execution?.queuedAt != null),
          runThreads,
        });
        yield* Effect.forEach(
          summaries,
          ({ threadId, summary }) => {
            const json = encodeStageSummary(summary);
            if (written.get(threadId) === json) return Effect.void;
            return engine
              .dispatch({
                type: "thread.crew-stage.set",
                commandId: CommandId.make(`workflow:crew-stage:${NodeCrypto.randomUUID()}`),
                threadId,
                crew: summary,
                ...(written.has(threadId) || title === null ? {} : { title: title.slice(0, 200) }),
              })
              .pipe(
                Effect.andThen(executions.setStageThread(threadId, featureId, json)),
                Effect.catch((error) =>
                  Effect.logWarning("Stage thread summary update failed", {
                    featureId,
                    threadId,
                    error,
                  }),
                ),
              );
          },
          { discard: true },
        );
      });

    /** Offers freed slots to queued features, oldest first. */
    const drainQueue = (except?: string): Effect.Effect<void, ExecutionError> =>
      executions.listSlots().pipe(
        Effect.flatMap((slots) =>
          Effect.forEach(
            slots.filter((slot) => slot.queuedAt !== null && slot.featureId !== except),
            (slot) =>
              reconcileFeatureUnlocked(slot.featureId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Queued workflow reconciliation failed", {
                    featureId: slot.featureId,
                    error,
                  }),
                ),
              ),
            { discard: true },
          ),
        ),
      );

    const reconcileFeatureUnlocked = (
      featureId: string,
      options: { readonly ignoreLimit?: boolean } = {},
    ): Effect.Effect<void, ExecutionError> =>
      advance(featureId, options.ignoreLimit ?? false).pipe(
        Effect.tapError((error) =>
          executions.update(featureId, String(error).slice(0, 2_000), false),
        ),
        Effect.ensuring(
          syncSlot(featureId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Workflow slot sync failed", { featureId, error }),
            ),
            Effect.andThen(
              syncStageThreads(featureId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Stage thread sync failed", { featureId, error }),
                ),
              ),
            ),
          ),
        ),
      );
    const reconcileFeature = (featureId: string) =>
      reconcileFeatureUnlocked(featureId).pipe(lock.withPermits(1));
    const reconcile = (projectId?: ProjectId) =>
      executions.listActive(projectId).pipe(
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
        Effect.andThen(drainQueue().pipe(lock.withPermits(1))),
      );

    /** Builds the event a decision records; the fold rejects decisions the state does not allow. */
    const controlEvent = (
      input: WorkflowControl,
      definition: WorkflowDefinition,
      state: WorkflowState,
      events: ReadonlyArray<WorkflowStepEvent>,
      text: string | null,
    ) =>
      Effect.gen(function* () {
        const reject = (reason: string) => Effect.fail(new WorkflowTransitionError(reason));
        const occurredAt = DateTime.formatIso(yield* DateTime.now);
        const base = {
          id: input.requestId,
          botRunId: null,
          outcome: null,
          sourceKind: null,
          sourceId: null,
          actorId: input.actorId,
          detail: null,
          occurredAt,
        } as const;
        if (input.kind === "reopened") {
          const stepId = state.cancelled ? state.stoppedStepId : input.stepId;
          if (!state.cancelled && !state.completed)
            return yield* reject("Only a cancelled or finished feature can reopen");
          if (!stepId) return yield* reject("Choose the stage the follow-up starts at");
          return {
            ...base,
            kind: input.kind,
            stepId,
            executionId: null,
          } satisfies WorkflowStepEvent;
        }
        const step = state.activeStepId ? state.steps.get(state.activeStepId) : undefined;
        if (!step) return yield* reject("No active workflow step");
        const event = { ...base, kind: input.kind, stepId: step.id, executionId: step.executionId };
        if (text !== null && text.length > 8_000)
          return yield* reject("Notes and answers are limited to 8000 characters");
        switch (input.kind) {
          case "answered": {
            if (!text || step.status !== "needs-input" || !step.botRunId) {
              return yield* reject("The active question needs an answer of 1-8000 characters");
            }
            const handoff = yield* handoffs.getForTargetRun(step.botRunId);
            if (!handoff || handoff.projectId !== input.projectId)
              return yield* reject("Question handoff is unavailable");
            return {
              ...event,
              sourceKind: "decision",
              sourceId: handoff.id,
              detail: text,
            } as const;
          }
          case "approved":
            return { ...event, detail: text };
          case "changes-requested":
            if (!text) return yield* reject("Request changes needs a note");
            return { ...event, detail: text };
          case "marked-done":
            if (!input.outcome || !text)
              return yield* reject("Mark done needs an outcome and a summary");
            return { ...event, outcome: input.outcome, detail: text };
          case "skipped":
          case "accepted":
            return {
              ...event,
              outcome: input.outcome ?? defaultForwardOutcome(definition, step.id),
            };
          case "sent-back": {
            if (!input.stepId) return yield* reject("Choose the stage to send back to");
            // The failure travels with the note, so the earlier stage sees what went wrong.
            const failure =
              step.status === "failed"
                ? events.findLast(
                    (item) =>
                      item.kind === "failed" &&
                      item.stepId === step.id &&
                      item.executionId === step.executionId,
                  )?.detail
                : null;
            const detail = [text, failure ? `Error from ${step.id}: ${failure}` : null]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 16_000);
            return { ...event, targetStepId: input.stepId, detail: detail || null };
          }
          case "retry":
            return input.modelSelection
              ? { ...event, modelSelection: input.modelSelection }
              : event;
          default:
            return event;
        }
      });

    return WorkflowExecutionService.of({
      control: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* workflows.getFeatureSnapshot(input.featureId, input.projectId);
          if (!snapshot)
            return yield* Effect.fail(
              new WorkflowTransitionError("Feature workflow was not found"),
            );
          const prior = yield* workflows.findRecordedEvent(input.featureId, input.requestId);
          const text = input.text?.trim() || null;
          if (prior) {
            if (
              prior.kind !== input.kind ||
              prior.actorId !== input.actorId ||
              (input.kind === "answered" && prior.detail !== text) ||
              (input.outcome !== undefined && prior.outcome !== input.outcome) ||
              (input.kind === "sent-back" && prior.targetStepId !== input.stepId)
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Request ID belongs to another action"),
              );
            }
          } else {
            const state = (yield* workflows.getFeatureState(input.featureId))!;
            const events = yield* store.listEvents(input.featureId);
            yield* workflows.recordTrustedEvent(
              input.featureId,
              yield* controlEvent(input, snapshot.definition, state, events, text),
            );
          }
          // Record the intent before side effects so restart replay can finish them.
          if (
            input.kind === "cancelled" ||
            input.kind === "taken-over" ||
            input.kind === "sent-back"
          ) {
            yield* stopCancelledRun(input.featureId);
          }
          if (input.kind === "reopened") yield* executions.update(input.featureId, null, false);
          if (input.kind === "answered" && !snapshot.executionConfigured) {
            const event = (yield* workflows.findRecordedEvent(input.featureId, input.requestId))!;
            if (event.sourceId && event.detail)
              yield* delegation.answer(event.sourceId, event.detail);
          }
          yield* reconcileFeatureUnlocked(input.featureId);
          return (yield* workflows.getFeatureSnapshot(input.featureId, input.projectId))!;
        }).pipe(lock.withPermits(1)),
      startNow: (featureId, projectId) =>
        Effect.gen(function* () {
          if (!(yield* workflows.getFeatureSnapshot(featureId, projectId)))
            return yield* Effect.fail(
              new WorkflowTransitionError("Feature workflow was not found"),
            );
          if ((yield* executions.get(featureId))?.queuedAt) {
            yield* reconcileFeatureUnlocked(featureId, { ignoreLimit: true });
          }
          return (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
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
