import {
  PROJECT_MANAGER_ROLE_ID,
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
import { WorkflowLibrary } from "./WorkflowLibrary.ts";
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
import {
  AUTO_WORKFLOW_ID,
  makeAutoWorkflow,
  makeStarterWorkflow,
  STARTER_WORKFLOW_ID,
} from "./starterWorkflow.ts";

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
    /** The feature's worktree; the project's checkout when null. */
    readonly worktreePath: string | null;
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

export const WorkflowServiceLive = Layer.effect(
  WorkflowService,
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const crew = yield* CrewStore;
    const runtime = yield* CrewThreadRuntime;
    const workspace = yield* WorkflowWorkspace;
    const stageHandoffs = yield* WorkflowStageHandoffStore;
    const library = yield* WorkflowLibrary;

    /** Newest version of every output so far, with each producing stage's thread diff. */
    const stageOutputs = Effect.fn("WorkflowService.stageOutputs")(function* (
      definition: WorkflowDefinition,
      events: ReadonlyArray<WorkflowStepEvent>,
    ) {
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

    const checkDefinition = Effect.fn("WorkflowService.checkDefinition")(function* (
      definition: WorkflowDefinition,
    ) {
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
        const problem = !role
          ? "does not exist"
          : !role.enabled
            ? "is turned off"
            : manager
              ? null
              : !role.autoCreateForFeature
                ? "can't run workflow stages"
                : role.revision !== slot.roleRevision
                  ? `was edited; pin roleRevision ${role.revision}`
                  : null;
        if (problem !== null) {
          return yield* Effect.fail(
            new WorkflowValidationError(`Workflow role ${slot.roleId} ${problem}`),
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

    // Untraced: each caller below is the span.
    const ensureBuiltIn = Effect.fnUntraced(function* (
      id: string,
      make: (roleRevisions: Readonly<Record<string, number>>) => WorkflowDefinition,
    ) {
      const existing = yield* store.getLatestDefinition(id);
      if (existing !== null) return existing;
      const revisions: Record<string, number> = {};
      for (const role of yield* crew.listRoles()) revisions[role.id] = role.revision;
      const definition = make(revisions);
      yield* checkDefinition(definition);
      if (yield* store.createDefinition(definition, DateTime.formatIso(yield* DateTime.now))) {
        yield* library.changed;
        return definition;
      }
      const concurrent = yield* store.getLatestDefinition(id);
      if (concurrent === null) {
        return yield* Effect.fail(new WorkflowValidationError(`Workflow ${id} is unavailable`));
      }
      return concurrent;
    });

    return WorkflowService.of({
      validateDefinition: checkDefinition,
      ensureStarterDefinition: Effect.fn("WorkflowService.ensureStarterDefinition")(function* () {
        const existing = yield* store.getLatestDefinition(STARTER_WORKFLOW_ID);
        if (existing !== null) return existing;
        // A new library gets the auto variant with it; one deleted later stays deleted.
        const starter = yield* ensureBuiltIn(STARTER_WORKFLOW_ID, makeStarterWorkflow);
        yield* ensureBuiltIn(AUTO_WORKFLOW_ID, makeAutoWorkflow);
        return starter;
      }),
      createDefinition: Effect.fn("WorkflowService.createDefinition")(function* (definition) {
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
        yield* library.changed;
        return definition;
      }),
      reviseDefinition: Effect.fn("WorkflowService.reviseDefinition")(
        function* (definition, expectedRevision) {
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
          yield* library.changed;
          return definition;
        },
      ),
      copyForFeature: Effect.fn("WorkflowService.copyForFeature")(
        function* (featureId, projectId, workflowId) {
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
        },
      ),
      getFeatureCopy: store.getFeatureCopy,
      findRecordedEvent: Effect.fn("WorkflowService.findRecordedEvent")((featureId, eventId) =>
        store
          .listEvents(featureId)
          .pipe(Effect.map((events) => events.find((event) => event.id === eventId) ?? null)),
      ),
      deleteDefinition: Effect.fn("WorkflowService.deleteDefinition")(function* (id) {
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
        yield* library.changed;
      }),
      getLatestDefinition: store.getLatestDefinition,
      listLatestDefinitions: store.listLatestDefinitions,
      getFeatureState: Effect.fn("WorkflowService.getFeatureState")(function* (featureId) {
        const copy = yield* store.getFeatureCopy(featureId);
        if (copy === null) return null;
        const events = yield* store.listEvents(featureId);
        return yield* projectState(copy.definition, events);
      }),
      getFeatureSnapshot: Effect.fn("WorkflowService.getFeatureSnapshot")(
        function* (featureId, projectId) {
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
        },
      ),
      prepareStageHandoff: Effect.fn("WorkflowService.prepareStageHandoff")(function* (input) {
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
        const stageWorkspace = yield* workspace.describe(copy.projectId, input.worktreePath, files);
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
      getStageHandoffForThread: Effect.fn("WorkflowService.getStageHandoffForThread")(
        function* (projectId, threadId) {
          const run = yield* crew.getRunByThread(threadId);
          const start = run ? yield* store.findStageStart(run.id) : null;
          const record = start ? yield* stageHandoffs.get(start.handoffId) : null;
          if (!record) return null;
          const copy = yield* store.getFeatureCopy(record.featureId);
          return copy?.projectId === projectId ? record : null;
        },
      ),
      recordTrustedEvent: Effect.fn("WorkflowService.recordTrustedEvent")(
        function* (featureId, event) {
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
            // The stage record the run started from is the dispatch receipt.
            const record = event.sourceId ? yield* stageHandoffs.get(event.sourceId) : null;
            const role = copy.definition.roles[step.role];
            if (
              !run ||
              !member ||
              !record ||
              !role ||
              run.projectId !== copy.projectId ||
              record.featureId !== featureId ||
              record.stepId !== event.stepId ||
              record.executionId !== event.executionId ||
              !memberFillsRole(member, role, featureId, copy.projectId)
            ) {
              return yield* Effect.fail(
                new WorkflowTransitionError("Step run does not belong to its assigned crew member"),
              );
            }
          }
          // A stage reports through its own thread, so its result names the step's run.
          if (
            (event.kind === "completed" || event.kind === "question") &&
            event.sourceKind === "handoff" &&
            (event.runId === null || event.runId !== current.steps.get(event.stepId)?.runId)
          ) {
            return yield* Effect.fail(
              new WorkflowTransitionError("Step result does not come from the step's run"),
            );
          }
          if (event.kind === "answered") {
            const start = events.findLast(
              (item) =>
                item.kind === "started" && item.runId === current.steps.get(event.stepId)?.runId,
            );
            if (event.sourceKind !== "decision" || !start || event.sourceId !== start.sourceId) {
              return yield* Effect.fail(
                new WorkflowTransitionError("An answer needs the active step's question"),
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
        },
      ),
    });
  }),
);
