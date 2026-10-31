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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BotStore from "../bots/BotStore.ts";
import { featureTag } from "../features/featureIssue.ts";
import {
  CrewHandoffService,
  WORKFLOW_HANDOFF_PREFIX,
  type CrewHandoffError,
} from "../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../crew/CrewHandoffStore.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import type { CrewServiceError } from "../crew/CrewService.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WorkflowExecutionStore, type WorkflowBindings } from "./WorkflowExecutionStore.ts";
import { renderStageHandoff } from "./StageHandoff.ts";
import { stageThreadSummaries } from "./CrewStageThreads.ts";
import { memberFillsRole, WorkflowService, type WorkflowServiceError } from "./WorkflowService.ts";
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
  | CrewServiceError
  | CrewHandoffError
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
  /** The answer, gate note, send-back note, Mark done summary or cancel reason. */
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

/**
 * Names the feature first, since a headquarters follows many features and its notices quote
 * this line. A task already at the handoff limit goes as it is rather than being cut.
 */
const withFeatureName = (title: string, taskText: string) => {
  const named = `Feature "${title.trim()}". ${taskText}`;
  return title.trim() && named.length <= 8_000 ? named : taskText;
};

const key = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");
const outcomeJson = Schema.fromJsonString(WorkflowHandoffOutcome);
const stageSummaryJson = Schema.fromJsonString(CrewStageSummary);
const encodeStageSummary = Schema.encodeSync(stageSummaryJson);
const decodeStageSummary = Schema.decodeUnknownOption(stageSummaryJson);

export const WorkflowExecutionServiceLive = Layer.effect(
  WorkflowExecutionService,
  Effect.gen(function* () {
    const executions = yield* WorkflowExecutionStore;
    const workflows = yield* WorkflowService;
    const store = yield* WorkflowStore;
    const crew = yield* CrewStore;
    const bots = yield* BotStore.BotStore;
    const handoffs = yield* CrewHandoffStore;
    const delegation = yield* CrewHandoffService;
    const engine = yield* OrchestrationEngineService;
    const settings = yield* ServerSettingsService;
    const lock = yield* Semaphore.make(1);

    const stopCancelledRun = Effect.fn("WorkflowExecutionService.stopCancelledRun")(function* (
      featureId: string,
    ) {
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
    const acquireSlot = Effect.fn("WorkflowExecutionService.acquireSlot")(function* (
      featureId: string,
      instanceId: string,
      ignoreLimit: boolean,
    ) {
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

    /** The thread's latest turn, if it finished, with its last reply as the stage result. */
    const finishedTurn = Effect.fn("WorkflowExecutionService.finishedTurn")(
      function* (threadId: ThreadId) {
        const shell = yield* engine.getThreadShell(threadId);
        const runId = shell?.latestRunId;
        if (!shell || !runId || shell.deletedAt !== null) return null;
        const records = yield* engine.getThreadRecords(threadId, ["runs", "messages"], {
          runIds: [runId],
          messageRunIds: [runId],
          messageRoles: ["assistant"],
        });
        const run = records.runs.find((candidate) => candidate.id === runId);
        if (run?.status !== "completed") return null;
        const reply = records.messages.findLast((message) => message.text.trim())?.text.trim();
        return {
          runId,
          summary: (reply || `Finished in thread "${shell.title}"`).slice(0, 8_000),
          completedAt: DateTime.formatIso(run.completedAt ?? (yield* DateTime.now)),
        };
      },
      Effect.mapError(() => new WorkflowTransitionError("Attached stage thread is unavailable")),
    );

    /** Records an automatic retry while the stage has retries left. */
    const applyFailurePolicy = Effect.fn("WorkflowExecutionService.applyFailurePolicy")(function* (
      featureId: string,
      definition: WorkflowDefinition,
      step: WorkflowStepState,
      events: ReadonlyArray<WorkflowStepEvent>,
    ) {
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
        runId: null,
        outcome: null,
        sourceKind: "workflow",
        sourceId: failure.id,
        actorId: "workflow",
        detail: null,
        occurredAt: DateTime.formatIso(yield* DateTime.now),
      });
      return true;
    });

    const advance = Effect.fn("WorkflowExecutionService.advance")(function* (
      featureId: string,
      ignoreLimit: boolean,
    ) {
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
        // An attached stage completes when its thread's turn finishes, through its gate.
        if (step.status === "taken-over" && step.threadId !== null && step.runId === null) {
          const turn = yield* finishedTurn(step.threadId);
          const id = turn && `attached-done:${key(featureId, step.executionId!, turn.runId)}`;
          // A turn completes the stage once. After Reopen or Take over, only a new turn does.
          if (!turn || !id || events.some((event) => event.id === id)) return;
          yield* workflows.recordTrustedEvent(featureId, {
            id,
            stepId,
            executionId: step.executionId,
            kind: "completed",
            runId: null,
            outcome: defaultForwardOutcome(copy.definition, stepId),
            sourceKind: "workflow",
            sourceId: turn.runId,
            actorId: "workflow",
            detail: turn.summary,
            occurredAt: turn.completedAt,
          });
          continue;
        }
        // Gates, Your call and taken-over stages wait for a person.
        if (!["pending", "running", "needs-input"].includes(step.status)) return;
        const eventIds = new Set(events.map((event) => event.id));
        if (step.status === "pending") {
          if (state.paused) return;
          const binding = execution.bindings[task.role];
          const source = binding ? yield* crew.getRun(binding.dispatchRunId) : null;
          const member = binding ? yield* crew.getMember(binding.memberId) : null;
          if (!binding || !source || !member)
            return yield* Effect.fail(
              new WorkflowTransitionError("Assigned dispatch run is unavailable"),
            );
          const instanceId = (step.modelSelection ?? member.modelSelection).instanceId;
          if (!(yield* acquireSlot(featureId, instanceId, ignoreLimit))) return;
          // After a move to another workflow the count starts again, so its start marks new IDs.
          const generation = copy.eventsFromSequence > 0 ? [copy.eventsFromSequence] : [];
          const executionId =
            step.executionId ??
            `execution:${key(featureId, ...generation, state.executionCount + 1, stepId)}`;
          const handoffId = `${WORKFLOW_HANDOFF_PREFIX}${key(featureId, executionId, step.attempt + 1)}`;
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
          const reservedRun = reserved ? yield* crew.getRun(reserved.targetRunId) : null;
          const dispatch =
            reserved?.status === "failed" && !reservedRun
              ? delegation.retry(handoffId)
              : delegation.delegate({
                  id: handoffId,
                  sourceThreadId: source.threadId,
                  targetMemberId: binding.memberId,
                  projectId: execution.projectId,
                  taskText: withFeatureName(execution.brief?.title ?? "", taskText),
                  // `attach` checked this source when the feature started.
                  boundByWorkflow: true,
                  contextText,
                  ...(step.modelSelection ? { modelSelection: step.modelSelection } : {}),
                });
          const result = yield* dispatch.pipe(Effect.result);
          const handoff = yield* handoffs.get(handoffId);
          const run = handoff ? yield* crew.getRun(handoff.targetRunId) : null;
          if (!handoff || !run) {
            if (result._tag === "Failure") return yield* Effect.fail(result.failure);
            return yield* Effect.fail(
              new WorkflowTransitionError("Dispatch did not create a crew run"),
            );
          }
          yield* workflows.recordTrustedEvent(featureId, {
            id: `start:${key(featureId, executionId, step.attempt + 1)}`,
            stepId,
            executionId,
            kind: "started",
            runId: run.id,
            outcome: null,
            sourceKind: "handoff",
            sourceId: handoffId,
            actorId: source.id,
            detail: null,
            occurredAt: handoff.createdAt,
          });
          if (result._tag === "Failure" && handoff.status === "queued") {
            yield* handoffs.transition(handoff.id, ["queued"], "failed", handoff.updatedAt, {
              lastError: "Crew thread dispatch failed; retry the step",
            });
          }
          // A provider can exit before the start event made the handoff discoverable.
          yield* delegation.refreshRun(run.id);
          yield* executions.update(featureId, null, false);
          continue;
        }
        const start = events.findLast(
          (event) => event.kind === "started" && event.runId === step.runId,
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
            receipt.handoff.status === "needs-input" && receipt.handoff.targetRunId === step.runId,
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
          if (handoff.targetRunId !== step.runId) continue;
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
            detail = "Assigned crew handoff was cancelled";
            sourceKind = null;
          } else continue;
          yield* workflows.recordTrustedEvent(featureId, {
            id,
            stepId,
            executionId: current.executionId,
            kind,
            runId: null,
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
    const syncSlot: (featureId: string) => Effect.Effect<void, ExecutionError> = Effect.fn(
      "WorkflowExecutionService.syncSlot",
    )(function* (featureId: string) {
      const execution = yield* executions.get(featureId);
      if (!execution) return;
      const state = yield* workflows.getFeatureState(featureId);
      const step = state?.activeStepId ? state.steps.get(state.activeStepId) : undefined;
      const holding = execution.queuedAt === null && execution.slotInstanceId !== null;
      if (!execution.settled && step?.status === "running") {
        if (holding) return;
        // An answered question resumes past the limit; count it so new stages wait.
        const run = step.runId ? yield* crew.getRun(step.runId) : null;
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
    const syncStageThreads: (featureId: string) => Effect.Effect<void, ExecutionError> = Effect.fn(
      "WorkflowExecutionService.syncStageThreads",
    )(function* (featureId: string) {
      const copy = yield* workflows.getFeatureCopy(featureId);
      const state = yield* workflows.getFeatureState(featureId);
      if (!copy || !state) return;
      const events = yield* store.listEvents(featureId);
      const execution = yield* executions.get(featureId);
      const runThreads = new Map<string, ThreadId>();
      for (const event of events) {
        if (event.kind !== "started" || !event.runId || runThreads.has(event.runId)) continue;
        const run = yield* crew.getRun(event.runId);
        if (run) runThreads.set(run.id, run.threadId);
      }
      const written = yield* executions.listStageThreads(featureId);
      const title = execution?.brief?.title.trim() || null;
      const summaries = stageThreadSummaries({
        featureId,
        definition: copy.definition,
        events,
        state: featureCardState(state, execution?.queuedAt != null),
        revision: copy.eventVersion,
        runThreads,
      });
      yield* Effect.forEach(
        summaries,
        ({ threadId, summary }) => {
          const json = encodeStageSummary(summary);
          const previous = written.get(threadId);
          if (previous === json) return Effect.void;
          // A thread that handed on keeps the summary it had then; only the current one
          // follows every decision, so long features don't rewrite their history.
          if (
            !summary.current &&
            previous !== undefined &&
            Option.exists(decodeStageSummary(previous), (stored) => !stored.current)
          )
            return Effect.void;
          return engine
            .dispatch({
              type: "thread.crew-stage.set",
              commandId: CommandId.make(`workflow:crew-stage:${NodeCrypto.randomUUID()}`),
              threadId,
              crew: summary,
              ...(title === null
                ? {}
                : {
                    feature: featureTag({
                      id: featureId,
                      title,
                      issue: execution?.brief?.issue ?? null,
                    }),
                  }),
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
        // A settled feature whose last summary write was lost gets it now.
        Effect.tap(() =>
          executions
            .listUnsyncedSettledFeatures(projectId)
            .pipe(
              Effect.flatMap((ids) =>
                Effect.forEach(
                  ids,
                  (id) =>
                    syncStageThreads(id).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Stage thread sync failed", { featureId: id, error }),
                      ),
                    ),
                  { discard: true },
                ),
              ),
            ),
        ),
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
    const controlEvent = Effect.fn("WorkflowExecutionService.controlEvent")(function* (
      input: WorkflowControl,
      definition: WorkflowDefinition,
      state: WorkflowState,
      events: ReadonlyArray<WorkflowStepEvent>,
      text: string | null,
    ) {
      const reject = (reason: string) => Effect.fail(new WorkflowTransitionError(reason));
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const base = {
        id: input.requestId,
        runId: null,
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
          if (!text || step.status !== "needs-input" || !step.runId) {
            return yield* reject("The active question needs an answer of 1-8000 characters");
          }
          const handoff = yield* handoffs.getForTargetRun(step.runId);
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
        case "cancelled":
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
          return input.modelSelection ? { ...event, modelSelection: input.modelSelection } : event;
        default:
          return event;
      }
    });

    return WorkflowExecutionService.of({
      control: Effect.fn("WorkflowExecutionService.control")(function* (input) {
        const snapshot = yield* workflows.getFeatureSnapshot(input.featureId, input.projectId);
        if (!snapshot)
          return yield* Effect.fail(new WorkflowTransitionError("Feature workflow was not found"));
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
      }, lock.withPermits(1)),
      startNow: Effect.fn("WorkflowExecutionService.startNow")(function* (featureId, projectId) {
        if (!(yield* workflows.getFeatureSnapshot(featureId, projectId)))
          return yield* Effect.fail(new WorkflowTransitionError("Feature workflow was not found"));
        if ((yield* executions.get(featureId))?.queuedAt) {
          yield* reconcileFeatureUnlocked(featureId, { ignoreLimit: true });
        }
        return (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
      }, lock.withPermits(1)),
      attach: Effect.fn("WorkflowExecutionService.attach")(
        function* (featureId, projectId, bindings) {
          const copy = yield* workflows.getFeatureCopy(featureId);
          if (!copy || copy.projectId !== projectId)
            return yield* Effect.fail(
              new WorkflowTransitionError(
                "Feature workflow belongs to another project or is unavailable",
              ),
            );
          if (Object.keys(bindings).length !== Object.keys(copy.definition.roles).length)
            return yield* Effect.fail(
              new WorkflowTransitionError("Every workflow role needs one binding"),
            );
          for (const [name, role] of Object.entries(copy.definition.roles)) {
            const binding = bindings[name];
            const member = binding ? yield* crew.getMember(binding.memberId) : null;
            const source = binding ? yield* crew.getRun(binding.dispatchRunId) : null;
            const sourceMember = source ? yield* crew.getActor(source.memberId) : null;
            if (
              !binding ||
              !member?.enabled ||
              !sourceMember?.enabled ||
              !source ||
              // The owning bot leads from its headquarters, outside the project.
              (source.projectId !== projectId &&
                (yield* bots.projectOwner(projectId)) !== source.memberId) ||
              !memberFillsRole(member, role, featureId, projectId) ||
              !member.allowedTools.includes("crew.respond") ||
              (role.supervisor !== null &&
                source.memberId !== bindings[role.supervisor]?.memberId) ||
              !(yield* crew.canDelegate(source.memberId, member.id, projectId))
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
                persisted.bindings[name]?.memberId !== binding.memberId ||
                persisted.bindings[name]?.dispatchRunId !== binding.dispatchRunId,
            )
          ) {
            return yield* Effect.fail(
              new WorkflowTransitionError("Workflow is already bound to another crew"),
            );
          }
          yield* reconcileFeature(featureId);
        },
      ),
      reconcileFeature,
      reconcile: Effect.fn("WorkflowExecutionService.reconcile")(() => reconcile()),
      start: Effect.fn("WorkflowExecutionService.start")(function* () {
        const handoffChanges = yield* handoffs.subscribeChanges;
        const workflowChanges = yield* store.subscribeChanges;
        const domainEvents = engine.streamDomainEvents;
        yield* Stream.runForEach(handoffChanges, (id) =>
          executions.findFeatureForHandoff(id).pipe(
            Effect.flatMap((featureId) => (featureId ? reconcileFeature(featureId) : Effect.void)),
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
          const threadId = event.payload.threadId;
          return handoffs.getRunByThread(threadId).pipe(
            Effect.tap((runId) =>
              // A person's thread attached as a stage finishes that stage when its turn ends.
              runId
                ? Effect.void
                : executions
                    .findFeaturesForThread(threadId)
                    .pipe(
                      Effect.flatMap((ids) =>
                        Effect.forEach(ids, reconcileFeature, { discard: true }),
                      ),
                    ),
            ),
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
