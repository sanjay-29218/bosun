import {
  PROJECT_MANAGER_ROLE_ID,
  WorkflowHandoffOutcome,
  WorkflowStepEvent,
  type ProjectId,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
  type WorkflowRole,
  type WorkflowStageHandoff,
  type WorkflowStageOutput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { projectManagerMemberId } from "../crew/CrewService.ts";
import { CrewStore, type CrewMember } from "../crew/CrewStore.ts";
import { CrewHandoffStore } from "../crew/CrewHandoffStore.ts";
import { CrewThreadRuntime } from "../crew/CrewThreadRuntime.ts";
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
import {
  collectNotes,
  collectStageOutputs,
  latestStageResults,
  previousFailure,
  selectReceived,
} from "./StageHandoff.ts";
import { WorkflowStageHandoffStore } from "./WorkflowStageHandoffStore.ts";
import { WorkflowWorkspace, type StageThreadDiff } from "./WorkflowWorkspace.ts";
import { makeStarterWorkflow, STARTER_WORKFLOW_ID } from "./starterWorkflow.ts";

export interface WorkflowServiceShape {
  readonly validateDefinition: (
    definition: WorkflowDefinition,
  ) => Effect.Effect<void, WorkflowServiceError>;
  readonly ensureStarterDefinition: () => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly createDefinition: (
    definition: WorkflowDefinition,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly reviseDefinition: (
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
  /**
   * Deletes a workflow from the library, refused while a feature that hasn't finished runs on
   * it or a bot starts its features on it. Finished features keep their own copy.
   */
  readonly deleteDefinition: (id: string) => Effect.Effect<void, WorkflowServiceError>;
  readonly getLatestDefinition: WorkflowStore["Service"]["getLatestDefinition"];
  readonly listLatestDefinitions: WorkflowStore["Service"]["listLatestDefinitions"];
  readonly getFeatureState: (
    featureId: string,
  ) => Effect.Effect<WorkflowState | null, WorkflowServiceError>;
  readonly getFeatureSnapshot: (
    featureId: string,
    projectId: ProjectId,
  ) => Effect.Effect<WorkflowFeatureSnapshot | null, WorkflowServiceError>;
  /**
   * Builds and persists what one stage attempt starts from, before it is dispatched.
   * Returns the persisted record, so a restart renders the same prompt.
   */
  readonly prepareStageHandoff: (input: {
    readonly featureId: string;
    readonly stepId: string;
    readonly executionId: string;
    readonly attempt: number;
    readonly handoffId: string;
  }) => Effect.Effect<WorkflowStageHandoff, WorkflowServiceError>;
  readonly getStageHandoff: (
    id: string,
  ) => Effect.Effect<WorkflowStageHandoff | null, WorkflowServiceError>;
  /** The handoff a stage thread started from, or null for threads outside a workflow. */
  readonly getStageHandoffForThread: (
    projectId: ProjectId,
    threadId: ThreadId,
  ) => Effect.Effect<WorkflowStageHandoff | null, WorkflowServiceError>;
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

/**
 * Whether `member` may perform workflow role `role` for one feature: its own member made from
 * the pinned role revision, or, for the project manager role, the project's manager.
 */
export const memberFillsRole = (
  member: CrewMember,
  role: WorkflowRole,
  featureId: string,
  projectId: ProjectId,
) =>
  member.projectId === projectId &&
  (role.roleId === PROJECT_MANAGER_ROLE_ID
    ? member.id === projectManagerMemberId(projectId) && member.featureId === null
    : member.featureId === featureId &&
      member.roleId === role.roleId &&
      member.roleRevision === role.roleRevision);

const validId = (value: string) => value.trim().length > 0 && value.length <= 128;
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(WorkflowStepEvent));
const decodeHandoffOutcome = Schema.decodeSync(Schema.fromJsonString(WorkflowHandoffOutcome));

export const WorkflowServiceLive = Layer.effect(
  WorkflowService,
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const crew = yield* CrewStore;
    const handoffs = yield* CrewHandoffStore;
    const runtime = yield* CrewThreadRuntime;
    const workspace = yield* WorkflowWorkspace;
    const stageHandoffs = yield* WorkflowStageHandoffStore;

    /** Newest version of every output so far, with each producing stage's thread diff. */
    const stageOutputs = (
      definition: WorkflowDefinition,
      events: ReadonlyArray<WorkflowStepEvent>,
    ) =>
      Effect.gen(function* () {
        const results = latestStageResults(events);
        const threads = new Map<string, ThreadId>();
        const diffs = new Map<ThreadId, StageThreadDiff>();
        for (const result of results) {
          const run = result.runId === null ? null : yield* crew.getRun(result.runId);
          if (run) threads.set(run.id, run.threadId);
          const threadId = result.threadId ?? run?.threadId;
          if (!threadId) continue;
          const diff = yield* workspace.threadDiff(threadId);
          if (diff) diffs.set(threadId, diff);
        }
        return collectStageOutputs(definition, results, threads, diffs);
      });

    const checkDefinition = (definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => validateWorkflowDefinition(definition),
          catch: (cause) =>
            cause instanceof WorkflowValidationError
              ? cause
              : new WorkflowValidationError("Invalid workflow definition"),
        });
        for (const slot of Object.values(definition.roles)) {
          const role = yield* crew.getRole(slot.roleId);
          // The project manager slot binds to the project's existing manager rather than a
          // member made from the pinned revision, so only stage roles check their pin.
          const manager = slot.roleId === PROJECT_MANAGER_ROLE_ID;
          if (
            !role?.enabled ||
            (!manager && (role.revision !== slot.roleRevision || !role.autoCreateForFeature))
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError(`Workflow role is unavailable: ${slot.roleId}`),
            );
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
      ensureStarterDefinition: () =>
        Effect.gen(function* () {
          const existing = yield* store.getLatestDefinition(STARTER_WORKFLOW_ID);
          if (existing !== null) return existing;
          const revisions: Record<string, number> = {};
          for (const role of yield* crew.listRoles()) revisions[role.id] = role.revision;
          const starter = makeStarterWorkflow(revisions);
          yield* checkDefinition(starter);
          const created = yield* store.createDefinition(
            starter,
            DateTime.formatIso(yield* DateTime.now),
          );
          if (created) return starter;
          const concurrent = yield* store.getLatestDefinition(STARTER_WORKFLOW_ID);
          if (concurrent === null) {
            return yield* Effect.fail(
              new WorkflowValidationError("Starter workflow is unavailable"),
            );
          }
          return concurrent;
        }),
      createDefinition: (definition) =>
        Effect.gen(function* () {
          if (definition.revision !== 1) {
            return yield* Effect.fail(
              new WorkflowValidationError("New workflows start at revision 1"),
            );
          }
          yield* checkDefinition(definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (!(yield* store.createDefinition(definition, createdAt))) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow ID is already in use"));
          }
          return definition;
        }),
      reviseDefinition: (definition, expectedRevision) =>
        Effect.gen(function* () {
          if (
            !Number.isSafeInteger(expectedRevision) ||
            expectedRevision < 1 ||
            definition.revision !== expectedRevision + 1
          ) {
            return yield* Effect.fail(new WorkflowValidationError("Invalid workflow revision"));
          }
          yield* checkDefinition(definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (!(yield* store.updateDefinition(definition, expectedRevision, createdAt))) {
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
          if (!(yield* runtime.projectExists(projectId))) {
            return yield* Effect.fail(new WorkflowValidationError("Project does not exist"));
          }
          const definition = yield* store.getLatestDefinition(workflowId);
          if (definition === null) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow does not exist"));
          }
          yield* checkDefinition(definition);
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
      deleteDefinition: (id) =>
        Effect.gen(function* () {
          const running: string[] = [];
          for (const feature of yield* store.listOpenFeaturesUsing(id)) {
            const copy = yield* store.getFeatureCopy(feature.id);
            if (copy === null) continue;
            const state = yield* projectState(copy.definition, yield* store.listEvents(feature.id));
            if (!state.completed && !state.cancelled) running.push(feature.title);
          }
          const bots = yield* store.listBotsDefaultingTo(id);
          const uses = [
            ...(running.length > 0
              ? [
                  `${running.length === 1 ? "feature" : "features"} ${running.map((title) => `"${title}"`).join(", ")} still ${running.length === 1 ? "runs" : "run"} on it`,
                ]
              : []),
            ...(bots.length > 0
              ? [
                  `${bots.join(", ")} ${bots.length === 1 ? "starts its" : "start their"} features with it`,
                ]
              : []),
          ];
          if (uses.length > 0) {
            return yield* Effect.fail(
              new WorkflowValidationError(`Can't delete this workflow: ${uses.join("; ")}.`),
            );
          }
          if (!(yield* store.deleteDefinition(id))) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow not found"));
          }
        }),
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
              step.runId === null
                ? Effect.succeed(step)
                : crew
                    .getRun(step.runId)
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
            outputs: yield* stageOutputs(copy.definition, events),
          } satisfies WorkflowFeatureSnapshot;
        }),
      prepareStageHandoff: (input) =>
        Effect.gen(function* () {
          const existing = yield* stageHandoffs.get(input.handoffId);
          if (existing) return existing;
          const copy = yield* store.getFeatureCopy(input.featureId);
          const step = copy?.definition.steps[input.stepId];
          if (!copy || step?.type !== "task") {
            return yield* Effect.fail(new WorkflowTransitionError("Stage is not a workflow task"));
          }
          const events = yield* store.listEvents(input.featureId);
          const received = selectReceived(
            copy.definition,
            input.stepId,
            yield* stageOutputs(copy.definition, events),
          );
          const files = received.flatMap((output) => (output.kind === "file" ? [output.path] : []));
          const stageWorkspace = yield* workspace.describe(copy.projectId, files);
          const outputs = received.map((output): WorkflowStageOutput =>
            output.kind === "file" && stageWorkspace.cwd !== null
              ? { ...output, exists: stageWorkspace.existing.has(output.path) }
              : output,
          );
          const { from, notes } = collectNotes(events, input.executionId);
          return yield* stageHandoffs.insertIfAbsent({
            id: input.handoffId,
            featureId: input.featureId,
            stepId: input.stepId,
            executionId: input.executionId,
            attempt: input.attempt,
            workflow: {
              id: copy.definition.id,
              name: copy.definition.name,
              revision: copy.definition.revision,
            },
            from,
            brief: yield* stageHandoffs.getFeatureBrief(input.featureId),
            task: step.task,
            scope: step.scope ?? null,
            outcomes: Object.keys(step.next),
            produces: [...(step.outputs ?? [])],
            outputs,
            notes: [...notes],
            retry: previousFailure(events, input.executionId, input.attempt),
            workspace: {
              cwd: stageWorkspace.cwd,
              branch: stageWorkspace.branch,
              commit: stageWorkspace.commit,
            },
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      getStageHandoff: stageHandoffs.get,
      getStageHandoffForThread: (projectId, threadId) =>
        Effect.gen(function* () {
          const runId = yield* handoffs.getRunByThread(threadId);
          const handoff = runId ? yield* handoffs.getForTargetRun(runId) : null;
          const record = handoff ? yield* stageHandoffs.get(handoff.id) : null;
          if (!record) return null;
          const copy = yield* store.getFeatureCopy(record.featureId);
          return copy?.projectId === projectId ? record : null;
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
            const run = event.runId ? yield* crew.getRun(event.runId) : null;
            const member = run ? yield* crew.getMember(run.memberId) : null;
            const liveHandoff = event.sourceId ? yield* handoffs.get(event.sourceId) : null;
            // Cancellation can arrive before the dispatcher records its start. Replay
            // the original dispatch receipt, then its cancellation, in that order.
            const handoff =
              liveHandoff?.status === "cancelled"
                ? yield* handoffEvidence(event.sourceId, "queued", run?.id)
                : liveHandoff;
            const role = copy.definition.roles[step.role];
            if (
              !run ||
              !member ||
              !handoff ||
              !role ||
              run.projectId !== copy.projectId ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== run.id ||
              handoff.targetMemberId !== member.id ||
              handoff.status === "cancelled" ||
              !memberFillsRole(member, role, featureId, copy.projectId)
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step run does not belong to its assigned crew member"),
              );
            }
          }
          if (
            event.kind === "completed" &&
            event.sourceKind === "handoff" &&
            step?.type === "task"
          ) {
            const runId = current.steps.get(event.stepId)?.runId;
            const handoff = yield* handoffEvidence(event.sourceId, "completed", runId);
            const run = runId ? yield* crew.getRun(runId) : null;
            if (
              !handoff ||
              !run ||
              handoff.status !== "completed" ||
              !handoff.responseText?.trim() ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== runId ||
              handoff.targetMemberId !== run.memberId
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step completion needs its completed crew handoff"),
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
                new WorkflowTransitionError("Recorded outcome does not match the crew handoff"),
              );
            }
          }
          if (
            (event.kind === "question" || event.kind === "answered" || event.kind === "failed") &&
            event.sourceKind === "handoff"
          ) {
            const runId = current.steps.get(event.stepId)?.runId;
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
            const run = runId ? yield* crew.getRun(runId) : null;
            if (
              !handoff ||
              !run ||
              handoff.projectId !== copy.projectId ||
              handoff.targetRunId !== runId ||
              handoff.targetMemberId !== run.memberId ||
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
                new WorkflowTransitionError("Step event does not match its crew handoff"),
              );
            }
            if ((event.kind === "question" || event.kind === "answered") && step?.type === "task") {
              const supervisorId = copy.definition.roles[step.role]?.supervisor;
              const supervisor =
                supervisorId === null || supervisorId === undefined
                  ? null
                  : copy.definition.roles[supervisorId];
              if (supervisor) {
                const sourceRun = yield* crew.getRun(handoff.sourceRunId);
                const sourceMember = sourceRun ? yield* crew.getMember(sourceRun.memberId) : null;
                if (
                  !sourceRun ||
                  !sourceMember ||
                  sourceRun.projectId !== copy.projectId ||
                  !memberFillsRole(sourceMember, supervisor, featureId, copy.projectId)
                ) {
                  return yield* Effect.fail(
                    new WorkflowTransitionError("Question did not reach the assigned supervisor"),
                  );
                }
              }
            }
          }
          if (event.kind === "answered" && event.sourceKind === "decision") {
            const runId = current.steps.get(event.stepId)?.runId;
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
