import {
  WorkflowHandoffOutcome,
  WorkflowStepEvent,
  type ProjectId,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BotStore } from "../bots/BotStore.ts";
import { BotHandoffStore } from "../bots/BotHandoffStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import { validateWorkflowDefinition, WorkflowValidationError } from "./WorkflowGraph.ts";
import {
  featureCardState,
  featureStage,
  projectWorkflowState,
  WorkflowTransitionError,
  type WorkflowState,
} from "./WorkflowState.ts";
import { WorkflowStore, type FeatureWorkflowCopy } from "./WorkflowStore.ts";
import { makeStarterWorkflow, STARTER_WORKFLOW_ID } from "./starterWorkflow.ts";

export interface WorkflowServiceShape {
  readonly validateDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinition,
  ) => Effect.Effect<void, WorkflowServiceError>;
  readonly ensureStarterDefinition: (
    projectId: ProjectId,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly createDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinition,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly reviseDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinition,
    expectedRevision: number,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly copyForFeature: (
    featureId: string,
    projectId: ProjectId,
    workflowId: string,
  ) => Effect.Effect<FeatureWorkflowCopy, WorkflowServiceError>;
  readonly getFeatureCopy: WorkflowStore["Service"]["getFeatureCopy"];
  readonly findRecordedEvent: (
    featureId: string,
    eventId: string,
  ) => Effect.Effect<WorkflowStepEvent | null, WorkflowServiceError>;
  readonly getLatestDefinition: WorkflowStore["Service"]["getLatestDefinition"];
  readonly listLatestDefinitions: WorkflowStore["Service"]["listLatestDefinitions"];
  readonly getFeatureState: (
    featureId: string,
  ) => Effect.Effect<WorkflowState | null, WorkflowServiceError>;
  readonly getFeatureSnapshot: (
    featureId: string,
    projectId: ProjectId,
  ) => Effect.Effect<WorkflowFeatureSnapshot | null, WorkflowServiceError>;
  /** Call only after authenticating the actor and verifying the source receipt. */
  readonly recordTrustedEvent: (
    featureId: string,
    event: WorkflowStepEvent,
  ) => Effect.Effect<WorkflowState, WorkflowServiceError>;
}

export type WorkflowServiceError =
  | WorkflowValidationError
  | WorkflowTransitionError
  | PersistenceSqlError
  | ProjectionRepositoryError;

export class WorkflowService extends Context.Service<WorkflowService, WorkflowServiceShape>()(
  "t3/workflows/WorkflowService",
) {}

const validId = (value: string) => value.trim().length > 0 && value.length <= 128;
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(WorkflowStepEvent));
const decodeHandoffOutcome = Schema.decodeSync(Schema.fromJsonString(WorkflowHandoffOutcome));

export const WorkflowServiceLive = Layer.effect(
  WorkflowService,
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const bots = yield* BotStore;
    const handoffs = yield* BotHandoffStore;
    const runtime = yield* BotThreadRuntime;

    const checkDefinition = (projectId: ProjectId, definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => validateWorkflowDefinition(definition),
          catch: (cause) =>
            cause instanceof WorkflowValidationError
              ? cause
              : new WorkflowValidationError("Invalid workflow definition"),
        });
        if (!(yield* runtime.projectExists(projectId))) {
          return yield* Effect.fail(new WorkflowValidationError("Project does not exist"));
        }
        for (const assignment of Object.values(definition.bots)) {
          const source = assignment.template;
          if (source.kind === "template") {
            const template = yield* bots.getTemplate(source.id);
            if (
              !template?.enabled ||
              !template.autoCreateForFeature ||
              template.revision !== source.revision ||
              (template.projectId !== null && template.projectId !== projectId)
            ) {
              return yield* Effect.fail(
                new WorkflowValidationError(`Feature bot template is unavailable: ${source.id}`),
              );
            }
          } else {
            const bot = yield* bots.getDefinition(source.id);
            if (!bot?.enabled || bot.projectId !== projectId || bot.featureId !== null) {
              return yield* Effect.fail(
                new WorkflowValidationError(`Project bot is unavailable: ${source.id}`),
              );
            }
          }
        }
      });

    const projectState = (
      definition: WorkflowDefinition,
      events: ReadonlyArray<WorkflowStepEvent>,
    ) =>
      Effect.try({
        try: () => projectWorkflowState(definition, events),
        catch: (cause) =>
          cause instanceof WorkflowTransitionError
            ? cause
            : new WorkflowTransitionError("Invalid workflow history"),
      });

    const handoffEvidence = (
      id: string | null,
      status?: "completed" | "needs-input" | "running" | "failed" | "queued",
      runId?: string | null,
      detail?: string | null,
    ) =>
      Effect.gen(function* () {
        if (id === null) return null;
        const current = yield* handoffs.get(id);
        const receipts = yield* handoffs.listReceipts(id);
        const candidates = [
          ...receipts.map((receipt) => receipt.handoff),
          ...(current ? [current] : []),
        ];
        return (
          candidates.findLast(
            (handoff) =>
              (status === undefined || handoff.status === status) &&
              (runId === undefined || handoff.targetRunId === runId) &&
              (detail === undefined ||
                (status === "needs-input"
                  ? handoff.questionText?.trim() === detail?.trim()
                  : status === "failed"
                    ? handoff.lastError?.trim() === detail?.trim() ||
                      handoff.responseText?.trim() === detail?.trim()
                    : handoff.responseText?.trim() === detail?.trim())),
          ) ?? null
        );
      });

    return WorkflowService.of({
      validateDefinition: checkDefinition,
      ensureStarterDefinition: (projectId) =>
        Effect.gen(function* () {
          const existing = yield* store.getLatestDefinition(projectId, STARTER_WORKFLOW_ID);
          if (existing !== null) return existing;
          const revisions: Record<string, number> = {};
          for (const role of ["planner", "designer", "builder", "qa-tester", "reviewer"]) {
            const template = yield* bots.getTemplate(`template:${role}:${projectId}`);
            if (template) revisions[role] = template.revision;
          }
          const starter = makeStarterWorkflow(projectId, revisions);
          yield* checkDefinition(projectId, starter);
          const created = yield* store.createDefinition(
            projectId,
            starter,
            DateTime.formatIso(yield* DateTime.now),
          );
          if (created) return starter;
          const concurrent = yield* store.getLatestDefinition(projectId, STARTER_WORKFLOW_ID);
          if (concurrent === null) {
            return yield* Effect.fail(
              new WorkflowValidationError("Starter workflow is unavailable"),
            );
          }
          return concurrent;
        }),
      createDefinition: (projectId, definition) =>
        Effect.gen(function* () {
          if (definition.revision !== 1) {
            return yield* Effect.fail(
              new WorkflowValidationError("New workflows start at revision 1"),
            );
          }
          yield* checkDefinition(projectId, definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (!(yield* store.createDefinition(projectId, definition, createdAt))) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow ID is already in use"));
          }
          return definition;
        }),
      reviseDefinition: (projectId, definition, expectedRevision) =>
        Effect.gen(function* () {
          if (
            !Number.isSafeInteger(expectedRevision) ||
            expectedRevision < 1 ||
            definition.revision !== expectedRevision + 1
          ) {
            return yield* Effect.fail(new WorkflowValidationError("Invalid workflow revision"));
          }
          yield* checkDefinition(projectId, definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (
            !(yield* store.updateDefinition(projectId, definition, expectedRevision, createdAt))
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError("Workflow changed; reload and retry"),
            );
          }
          return definition;
        }),
      copyForFeature: (featureId, projectId, workflowId) =>
        Effect.gen(function* () {
          if (!validId(featureId) || !validId(workflowId)) {
            return yield* Effect.fail(
              new WorkflowValidationError("Invalid feature or workflow ID"),
            );
          }
          const existing = yield* store.getFeatureCopy(featureId);
          if (existing !== null) {
            if (existing.projectId !== projectId || existing.definition.id !== workflowId) {
              return yield* Effect.fail(
                new WorkflowValidationError("Feature is attached to another workflow"),
              );
            }
            return existing;
          }
          const definition = yield* store.getLatestDefinition(projectId, workflowId);
          if (definition === null) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow does not exist"));
          }
          yield* checkDefinition(projectId, definition);
          const copy = yield* store.copyForFeature(
            featureId,
            projectId,
            workflowId,
            definition.revision,
            DateTime.formatIso(yield* DateTime.now),
          );
          if (copy === null || copy.projectId !== projectId || copy.definition.id !== workflowId) {
            return yield* Effect.fail(
              new WorkflowValidationError("Feature is attached to another workflow"),
            );
          }
          return copy;
        }),
      getFeatureCopy: store.getFeatureCopy,
      findRecordedEvent: (featureId, eventId) =>
        store
          .listEvents(featureId)
          .pipe(Effect.map((events) => events.find((event) => event.id === eventId) ?? null)),
      getLatestDefinition: store.getLatestDefinition,
      listLatestDefinitions: store.listLatestDefinitions,
      getFeatureState: (featureId) =>
        Effect.gen(function* () {
          const copy = yield* store.getFeatureCopy(featureId);
          if (copy === null) return null;
          const events = yield* store.listEvents(featureId);
          return yield* projectState(copy.definition, events);
        }),
      getFeatureSnapshot: (featureId, projectId) =>
        Effect.gen(function* () {
          const copy = yield* store.getFeatureCopy(featureId);
          if (copy === null) return null;
          if (copy.projectId !== projectId) {
            return yield* Effect.fail(
              new WorkflowValidationError("Feature belongs to another project"),
            );
          }
          const events = yield* store.listEvents(featureId);
          const state = yield* projectState(copy.definition, events);
          const execution = yield* store.getExecutionStatus(featureId);
          const steps = yield* Effect.forEach(
            [...state.steps.values()],
            ({ modelSelection: _override, ...step }) =>
              step.botRunId === null
                ? Effect.succeed({ ...step, threadId: null })
                : bots
                    .getRun(step.botRunId)
                    .pipe(Effect.map((run) => ({ ...step, threadId: run?.threadId ?? null }))),
            { concurrency: 8 },
          );
          const queuedAt = execution?.queuedAt ?? null;
          return {
            featureId,
            projectId,
            definition: copy.definition,
            eventVersion: copy.eventVersion,
            createdAt: copy.createdAt,
            steps,
            activeStepId: state.activeStepId,
            readyStepIds: [...state.readyStepIds],
            executionCount: state.executionCount,
            completed: state.completed,
            cancelled: state.cancelled,
            paused: state.paused,
            executionConfigured: execution !== null,
            executionError: execution?.lastError ?? null,
            state: featureCardState(state, queuedAt !== null),
            queuedAt,
            stage: featureStage(copy.definition, state),
            yourCall: state.yourCall,
            historyLength: events.length,
            recentEvents: events.slice(-100),
          } satisfies WorkflowFeatureSnapshot;
        }),
      recordTrustedEvent: (featureId, event) =>
        Effect.gen(function* () {
          const copy = yield* store.getFeatureCopy(featureId);
          if (copy === null) {
            return yield* Effect.fail(
              new WorkflowTransitionError("Feature workflow does not exist"),
            );
          }
          const events = yield* store.listEvents(featureId);
          const prior = events.find((item) => item.id === event.id);
          if (prior) {
            if (encodeEvent(prior) !== encodeEvent(event)) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Event ID belongs to another outcome"),
              );
            }
            return yield* projectState(copy.definition, events);
          }
          const current = yield* projectState(copy.definition, events);
          const next = yield* projectState(copy.definition, [...events, event]);
          const step = Object.hasOwn(copy.definition.steps, event.stepId)
            ? copy.definition.steps[event.stepId]
            : undefined;
          if (event.kind === "started" && step?.type === "task") {
            const run = event.botRunId ? yield* bots.getRun(event.botRunId) : null;
            const bot = run ? yield* bots.getDefinition(run.botId) : null;
            const liveHandoff = event.sourceId ? yield* handoffs.get(event.sourceId) : null;
            // Cancellation can arrive before the dispatcher records its start. Replay
            // the original dispatch receipt, then its cancellation, in that order.
            const handoff =
              liveHandoff?.status === "cancelled"
                ? yield* handoffEvidence(event.sourceId, "queued", run?.id)
                : liveHandoff;
            const source = copy.definition.bots[step.bot]?.template;
            if (
              !run ||
              !bot ||
              !handoff ||
              !source ||
              run.projectId !== copy.projectId ||
              bot.projectId !== copy.projectId ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== run.id ||
              handoff.targetBotId !== bot.id ||
              handoff.status === "cancelled" ||
              (source.kind === "template"
                ? bot.featureId !== featureId ||
                  bot.templateId !== source.id ||
                  bot.templateRevision !== source.revision
                : bot.id !== source.id || bot.featureId !== null)
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step run does not belong to its assigned bot"),
              );
            }
          }
          if (event.kind === "completed" && step?.type === "task") {
            const runId = current.steps.get(event.stepId)?.botRunId;
            const handoff = yield* handoffEvidence(event.sourceId, "completed", runId);
            const run = runId ? yield* bots.getRun(runId) : null;
            if (
              !handoff ||
              !run ||
              handoff.status !== "completed" ||
              !handoff.responseText?.trim() ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== runId ||
              handoff.targetBotId !== run.botId
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step completion needs its completed bot handoff"),
              );
            }
            const recorded = yield* Effect.try({
              try: () => decodeHandoffOutcome(handoff.responseText!),
              catch: () =>
                new WorkflowTransitionError("Handoff result must contain an outcome and summary"),
            });
            if (
              recorded.outcome !== event.outcome ||
              recorded.summary.trim() !== event.detail?.trim()
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Recorded outcome does not match the bot handoff"),
              );
            }
          }
          if (
            (event.kind === "question" || event.kind === "answered" || event.kind === "failed") &&
            event.sourceKind === "handoff"
          ) {
            const runId = current.steps.get(event.stepId)?.botRunId;
            const handoff = yield* handoffEvidence(
              event.sourceId,
              event.kind === "question"
                ? "needs-input"
                : event.kind === "answered"
                  ? "running"
                  : "failed",
              runId,
              event.detail,
            );
            const run = runId ? yield* bots.getRun(runId) : null;
            if (
              !handoff ||
              !run ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== runId ||
              handoff.targetBotId !== run.botId ||
              (event.kind === "question" &&
                (handoff.status !== "needs-input" ||
                  handoff.questionText?.trim() !== event.detail?.trim())) ||
              (event.kind === "answered" &&
                (handoff.status !== "running" ||
                  handoff.responseText?.trim() !== event.detail?.trim())) ||
              (event.kind === "failed" &&
                (handoff.status !== "failed" ||
                  (handoff.lastError?.trim() !== event.detail?.trim() &&
                    handoff.responseText?.trim() !== event.detail?.trim())))
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step event does not match its bot handoff"),
              );
            }
            if ((event.kind === "question" || event.kind === "answered") && step?.type === "task") {
              const supervisorId = copy.definition.bots[step.bot]?.supervisor;
              const supervisorSource =
                supervisorId === null || supervisorId === undefined
                  ? null
                  : copy.definition.bots[supervisorId]?.template;
              if (supervisorSource) {
                const sourceRun = yield* bots.getRun(handoff.sourceRunId);
                const sourceBot = sourceRun ? yield* bots.getDefinition(sourceRun.botId) : null;
                if (
                  !sourceRun ||
                  !sourceBot ||
                  sourceRun.projectId !== copy.projectId ||
                  (supervisorSource.kind === "template"
                    ? sourceBot.featureId !== featureId ||
                      sourceBot.templateId !== supervisorSource.id ||
                      sourceBot.templateRevision !== supervisorSource.revision
                    : sourceBot.id !== supervisorSource.id || sourceBot.featureId !== null)
                ) {
                  return yield* Effect.fail(
                    new WorkflowTransitionError("Question did not reach the assigned supervisor"),
                  );
                }
              }
            }
          }
          if (event.kind === "answered" && event.sourceKind === "decision") {
            const runId = current.steps.get(event.stepId)?.botRunId;
            const handoff = yield* handoffEvidence(event.sourceId, "needs-input", runId);
            if (!handoff || handoff.projectId !== copy.projectId) {
              return yield* Effect.fail(
                new WorkflowTransitionError(
                  "Answer decision needs the active step's question receipt",
                ),
              );
            }
          }
          const result = yield* store.appendEvent(featureId, copy.eventVersion, event);
          if (result.kind === "conflict") {
            return yield* Effect.fail(
              new WorkflowTransitionError("Workflow changed; reload and retry"),
            );
          }
          if (result.kind === "duplicate" && encodeEvent(result.event) !== encodeEvent(event)) {
            return yield* Effect.fail(
              new WorkflowTransitionError("Event ID belongs to another outcome"),
            );
          }
          if (result.kind === "duplicate") {
            return yield* projectState(copy.definition, yield* store.listEvents(featureId));
          }
          return next;
        }),
    });
  }),
);
