// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  workflowForwardOutcome,
  workflowForwardStages,
  type FeatureAttachThreadInput,
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type FeatureThreadLink,
  type ProjectId,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { BotHandoffStore } from "../bots/BotHandoffStore.ts";
import { BotService, type BotServiceError } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkflowService, type WorkflowServiceError } from "../workflows/WorkflowService.ts";
import {
  WorkflowExecutionService,
  type WorkflowExecutionError,
} from "../workflows/WorkflowExecutionService.ts";
import {
  WorkflowExecutionStore,
  type WorkflowBindings,
} from "../workflows/WorkflowExecutionStore.ts";
import { featureCardState, stagePosition } from "../workflows/WorkflowState.ts";

export class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export type FeatureRecord = typeof FeatureRecordSchema.Type;
export type CreateFeatureInput = typeof FeatureCreateInput.Type;

export type FeatureServiceError =
  | FeatureValidationError
  | BotServiceError
  | PersistenceSqlError
  | WorkflowServiceError
  | WorkflowExecutionError;

export interface FeatureServiceShape {
  readonly create: (input: CreateFeatureInput) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly setStatus: (
    id: string,
    projectId: ProjectId,
    status: FeatureRecord["status"],
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  /**
   * Starts the feature's workflow. Each stage is sent from a lead run: its supervisor's, or the
   * Captain's for stages without one. Those threads are where stage questions and notices land.
   */
  readonly start: (
    id: string,
    projectId: ProjectId,
  ) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /** Opens a closed feature and resumes it: where it stopped, or at `stepId` after Done. */
  readonly reopen: (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly requestId: string;
    readonly actorId: string;
    readonly stepId?: string;
  }) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /**
   * Makes a person's existing thread the `stageId` stage of a new feature. The thread keeps
   * its ID, history, branch and worktree; earlier stages are skipped, and the stage completes
   * when the thread's turn finishes. A retry with the same feature ID returns the same feature.
   */
  readonly attachThread: (
    input: typeof FeatureAttachThreadInput.Type & { readonly actorId: string },
  ) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /**
   * Cancels the feature whose current stage this thread is, leaving the thread running as a
   * plain thread. Reopening the feature makes an attached thread its stage thread again.
   */
  readonly detachThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly actorId: string;
  }) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /** The feature stage a thread drives, preferring one it is the current stage of. */
  readonly threadLink: (
    projectId: ProjectId,
    threadId: ThreadId,
  ) => Effect.Effect<FeatureThreadLink, FeatureServiceError>;
  readonly get: (id: string) => Effect.Effect<FeatureRecord | null, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureRecord>, PersistenceSqlError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()(
  "t3/features/FeatureService",
) {}

const validText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

const hashed = (prefix: string, featureId: string, id: string) =>
  `${prefix}:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([featureId, id]))
    .digest("hex")
    .slice(0, 32)}`;
const featureBotId = (featureId: string, templateId: string) =>
  hashed("feature-bot", featureId, templateId);
const CAPTAIN_BOT_ID = "bot-captain";

const leadTask = (feature: FeatureRecord, definition: WorkflowDefinition, captain: boolean) =>
  [
    captain
      ? `You keep feature "${feature.title}" (${feature.id}) moving on workflow ${definition.name}.`
      : `You lead feature "${feature.title}" (${feature.id}) on workflow ${definition.name}.`,
    "The workflow sends each stage to its bot, so never delegate stage work yourself.",
    captain
      ? "Stage notices arrive here. Tell the person only what they must decide."
      : "Stage bots ask you questions here. Answer with bots_answer when the brief or earlier results settle it; otherwise say exactly what the person must decide.",
    `Brief:\n${feature.brief.slice(0, 8_000)}`,
  ].join("\n\n");

const assignmentsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeAssignments = Schema.encodeSync(assignmentsJson);
const decodeAssignments = Schema.decodeSync(assignmentsJson);
interface FeatureRow extends Omit<FeatureRecord, "botAssignments"> {
  readonly botAssignmentsJson: string;
}

export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* BotService;
    const botStore = yield* BotStore;
    const runtime = yield* BotThreadRuntime;
    const workflows = yield* WorkflowService;
    const executions = yield* WorkflowExecutionStore;
    const execution = yield* WorkflowExecutionService;
    const handoffStore = yield* BotHandoffStore;
    const engine = yield* OrchestratorV2;
    const queryError = toPersistenceSqlError("FeatureService.query");
    const decodeRow = (row: FeatureRow) =>
      Effect.try({
        try: () => {
          const { botAssignmentsJson, ...feature } = row;
          return { ...feature, botAssignments: decodeAssignments(botAssignmentsJson) };
        },
        catch: toPersistenceSqlError("FeatureService.decode"),
      });

    const get: FeatureServiceShape["get"] = (id) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, w.workflow_id AS workflowId,
          w.workflow_revision AS workflowRevision,
          f.bot_assignments_json AS botAssignmentsJson
        FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
        WHERE f.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => (rows[0] ? decodeRow(rows[0]) : Effect.succeed(null))),
      );

    const requireFeature = (id: string, projectId: ProjectId) =>
      get(id).pipe(
        Effect.flatMap((feature) =>
          feature && feature.projectId === projectId
            ? Effect.succeed(feature)
            : Effect.fail(new FeatureValidationError("Feature not found in project")),
        ),
      );

    /** One lead run per dispatching bot, created once per feature. */
    const leadBindings = (feature: FeatureRecord, definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        const bindings: Record<string, WorkflowBindings[string]> = {};
        for (const [name, assignment] of Object.entries(definition.bots)) {
          const botId = feature.botAssignments[name];
          const leadBotId =
            assignment.supervisor === null
              ? CAPTAIN_BOT_ID
              : feature.botAssignments[assignment.supervisor];
          if (!botId || !leadBotId) {
            return yield* Effect.fail(
              new FeatureValidationError(`Workflow bot ${name} has no feature bot`),
            );
          }
          if (leadBotId === CAPTAIN_BOT_ID) {
            if (!(yield* botStore.getDefinition(CAPTAIN_BOT_ID))?.enabled) {
              return yield* Effect.fail(
                new FeatureValidationError("Set up the crew before starting a feature"),
              );
            }
            if (!(yield* botStore.canDelegate(CAPTAIN_BOT_ID, botId))) {
              yield* bots.allowDelegation(CAPTAIN_BOT_ID, botId);
            }
          }
          const run = yield* bots.createRun({
            id: hashed("feature-lead", feature.id, leadBotId),
            botId: leadBotId,
            projectId: feature.projectId,
            taskText: leadTask(feature, definition, leadBotId === CAPTAIN_BOT_ID),
          });
          bindings[name] = { botId, dispatchRunId: run.id };
        }
        return bindings;
      });

    const create: FeatureServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        if (
          !validText(input.id, 128) ||
          !validText(input.title, 200) ||
          !validText(input.brief, 16_000)
        ) {
          return yield* Effect.fail(new FeatureValidationError("Invalid feature fields"));
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new FeatureValidationError("Project does not exist"));
        }
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const existing = yield* get(input.id);
              if (existing) {
                if (
                  existing.projectId !== input.projectId ||
                  existing.title !== input.title ||
                  existing.brief !== input.brief ||
                  existing.workflowId !== (input.workflowId ?? null)
                ) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Feature ID belongs to another request"),
                  );
                }
                return existing;
              }

              if (input.workflowId === undefined && (yield* workflows.getFeatureCopy(input.id))) {
                return yield* Effect.fail(
                  new FeatureValidationError("Feature ID is already attached to a workflow"),
                );
              }

              const copy =
                input.workflowId === undefined
                  ? null
                  : yield* workflows.copyForFeature(input.id, input.projectId, input.workflowId);
              const templates =
                copy === null
                  ? (yield* botStore.listTemplatesForProject(input.projectId))
                      .filter((template) => template.enabled && template.autoCreateForFeature)
                      .map((template) => ({ name: template.id, template }))
                  : yield* Effect.forEach(
                      Object.entries(copy.definition.bots).filter(
                        ([, assignment]) => assignment.template.kind === "template",
                      ),
                      ([name, assignment]) =>
                        Effect.gen(function* () {
                          const template = yield* botStore.getTemplate(assignment.template.id);
                          if (
                            !template?.enabled ||
                            !template.autoCreateForFeature ||
                            (template.projectId !== null &&
                              template.projectId !== input.projectId) ||
                            template.revision !==
                              (assignment.template.kind === "template"
                                ? assignment.template.revision
                                : 0)
                          ) {
                            return yield* Effect.fail(
                              new FeatureValidationError(
                                "Workflow bot template changed; revise the workflow",
                              ),
                            );
                          }
                          return { name, template };
                        }),
                    );
              const managerId = `bot-manager:${input.projectId}`;
              const manager = yield* botStore.getDefinition(managerId);
              const bindings = new Map<string, string>();
              if (copy)
                for (const [name, assignment] of Object.entries(copy.definition.bots)) {
                  if (assignment.template.kind === "existing-project-bot") {
                    const bot = yield* botStore.getDefinition(assignment.template.id);
                    if (
                      !bot?.enabled ||
                      bot.projectId !== input.projectId ||
                      bot.featureId !== null
                    ) {
                      return yield* Effect.fail(
                        new FeatureValidationError("Workflow project bot is unavailable"),
                      );
                    }
                    bindings.set(name, assignment.template.id);
                  }
                }
              for (const { name, template } of templates) {
                const id = featureBotId(input.id, name);
                const existingBot = yield* botStore.getDefinition(id);
                if (existingBot) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Feature bot ID is already in use"),
                  );
                }
                yield* bots.createDefinition({
                  id,
                  projectId: input.projectId,
                  featureId: input.id,
                  templateId: template.id,
                  name: template.name,
                  instructions: template.instructions,
                  allowedTools: template.allowedTools,
                  modelSelection: template.modelSelection,
                  runtimeMode: template.runtimeMode,
                });
                bindings.set(name, id);
              }
              for (const [position, { name }] of templates.entries()) {
                const id = bindings.get(name)!;
                const supervisor = copy?.definition.bots[name]?.supervisor;
                const parentId = copy
                  ? supervisor
                    ? bindings.get(supervisor)
                    : null
                  : manager?.enabled && manager.projectId === input.projectId
                    ? manager.id
                    : null;
                if (parentId) {
                  yield* bots.setHierarchyParent(id, parentId, position);
                  yield* bots.allowDelegation(parentId, id);
                }
              }
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              const botAssignments = Object.fromEntries(bindings);
              yield* sql`
              INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, bot_assignments_json)
              VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt}, ${createdAt}, 'open', ${encodeAssignments(botAssignments)})
            `;
              return {
                ...input,
                workflowId: input.workflowId ?? null,
                workflowRevision: copy?.definition.revision ?? null,
                botAssignments,
                createdAt,
                updatedAt: createdAt,
                status: "open" as const,
              };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
      });

    const start: FeatureServiceShape["start"] = (id, projectId) =>
      Effect.gen(function* () {
        const feature = yield* requireFeature(id, projectId);
        if (feature.status !== "open") {
          return yield* Effect.fail(
            new FeatureValidationError("Reopen the feature before starting it"),
          );
        }
        const copy = yield* workflows.getFeatureCopy(id);
        if (!copy) {
          return yield* Effect.fail(new FeatureValidationError("This feature has no workflow"));
        }
        // Starting twice is a no-op: the execution already exists.
        if (!(yield* executions.get(id))) {
          yield* execution.attach(id, projectId, yield* leadBindings(feature, copy.definition));
        }
        return (yield* workflows.getFeatureSnapshot(id, projectId))!;
      });

    /** The stage `threadId` drives in one feature, from the workflow fold alone. */
    const stageInFeature = (
      featureId: string,
      projectId: ProjectId,
      threadId: ThreadId,
      runId: string | null,
    ) =>
      Effect.gen(function* () {
        const copy = yield* workflows.getFeatureCopy(featureId);
        const state =
          copy?.projectId === projectId ? yield* workflows.getFeatureState(featureId) : null;
        if (!copy || !state) return null;
        const step = [...state.steps.values()].find((candidate) =>
          runId === null ? candidate.threadId === threadId : candidate.botRunId === runId,
        );
        const position = step ? stagePosition(copy.definition, step.id) : null;
        if (!step || !position) return null;
        const queued = ((yield* executions.get(featureId))?.queuedAt ?? null) !== null;
        return {
          featureId,
          ...position,
          state: featureCardState(state, queued),
          current: state.activeStepId === step.id && !state.cancelled && !state.completed,
        };
      });

    const threadLink: FeatureServiceShape["threadLink"] = (projectId, threadId) =>
      Effect.gen(function* () {
        const runId = yield* handoffStore.getRunByThread(threadId);
        if (runId) {
          const handoff = yield* handoffStore.getForTargetRun(runId);
          const featureId = handoff ? yield* executions.findFeatureForHandoff(handoff.id) : null;
          const stage = featureId
            ? yield* stageInFeature(featureId, projectId, threadId, runId)
            : null;
          return { stage, attachable: false };
        }
        const stages = yield* Effect.forEach(
          yield* executions.findFeaturesForThread(threadId),
          (featureId) => stageInFeature(featureId, projectId, threadId, null),
        );
        const found = stages.filter((stage) => stage !== null);
        return {
          stage: found.find((stage) => stage.current) ?? found[0] ?? null,
          attachable: true,
        };
      });

    // Attach, detach and reopen check who owns a thread, then change it; one at a time.
    const ownership = yield* Semaphore.make(1);

    const readThread = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(() => new FeatureValidationError("Thread is unavailable")));

    return FeatureService.of({
      start,
      threadLink,
      attachThread: (input) =>
        Effect.gen(function* () {
          const shell = yield* readThread(engine.getThreadShell(input.threadId));
          if (!shell || shell.projectId !== input.projectId || shell.deletedAt !== null) {
            return yield* Effect.fail(new FeatureValidationError("Thread not found in project"));
          }
          if (shell.archivedAt !== null) {
            return yield* Effect.fail(
              new FeatureValidationError("Unarchive the thread before making it a feature"),
            );
          }
          if (yield* handoffStore.getRunByThread(input.threadId)) {
            return yield* Effect.fail(
              new FeatureValidationError("A bot's thread can't become a feature"),
            );
          }
          const attachId = hashed("attach", input.featureId, input.threadId);
          const prior = yield* workflows.findRecordedEvent(input.featureId, attachId);
          if (prior) {
            const existing = yield* get(input.featureId);
            if (
              prior.stepId !== input.stageId ||
              existing?.workflowId !== input.workflowId ||
              existing.title !== input.title
            ) {
              return yield* Effect.fail(
                new FeatureValidationError("Feature ID belongs to another request"),
              );
            }
            return yield* start(input.featureId, input.projectId);
          }
          if ((yield* threadLink(input.projectId, input.threadId)).stage?.current) {
            return yield* Effect.fail(
              new FeatureValidationError("This thread is already a feature's current stage"),
            );
          }
          // Check the crew first, so a feature is never left made but unstarted.
          if (!(yield* botStore.getDefinition(CAPTAIN_BOT_ID))?.enabled) {
            return yield* Effect.fail(
              new FeatureValidationError("Set up the crew before making a feature"),
            );
          }
          const { messages } = yield* readThread(
            engine.getThreadRecords(input.threadId, ["messages"], { messageRoles: ["user"] }),
          );
          const brief =
            messages
              .find((message) => message.text.trim())
              ?.text.trim()
              .slice(0, 16_000) || input.title;
          const occurredAt = DateTime.formatIso(yield* DateTime.now);
          const event = {
            botRunId: null,
            outcome: null,
            sourceKind: null,
            sourceId: null,
            actorId: input.actorId,
            detail: null,
            occurredAt,
          } as const;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* create({
                  id: input.featureId,
                  projectId: input.projectId,
                  title: input.title,
                  brief,
                  workflowId: input.workflowId,
                });
                const copy = (yield* workflows.getFeatureCopy(input.featureId))!;
                const stages = workflowForwardStages(copy.definition);
                const index = stages.indexOf(input.stageId);
                if (index < 0) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Choose a stage on the workflow's path"),
                  );
                }
                for (const stepId of stages.slice(0, index)) {
                  yield* workflows.recordTrustedEvent(input.featureId, {
                    ...event,
                    id: hashed("attach-skip", input.featureId, stepId),
                    stepId,
                    executionId: null,
                    kind: "skipped",
                    outcome: workflowForwardOutcome(copy.definition, stepId),
                  });
                }
                yield* workflows.recordTrustedEvent(input.featureId, {
                  ...event,
                  id: attachId,
                  stepId: input.stageId,
                  executionId: hashed("execution", input.featureId, input.stageId),
                  kind: "attached",
                  threadId: input.threadId,
                });
              }),
            )
            .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
          return yield* start(input.featureId, input.projectId);
        }).pipe(ownership.withPermits(1)),
      detachThread: ({ projectId, threadId, requestId, actorId }) =>
        Effect.gen(function* () {
          const detach = (featureId: string) =>
            execution.control({
              featureId,
              projectId,
              requestId,
              actorId,
              kind: "cancelled",
              text: "Detached from the workflow",
            });
          // A retry finishes on the feature it first detached, whatever the thread is now.
          for (const featureId of yield* executions.findFeaturesForThread(threadId)) {
            if (yield* workflows.findRecordedEvent(featureId, requestId))
              return yield* detach(featureId);
          }
          const { stage, attachable } = yield* threadLink(projectId, threadId);
          // Cancelling a bot's stage stops its run, so the thread could not carry on.
          if (!attachable) {
            return yield* Effect.fail(
              new FeatureValidationError(
                "A bot's stage thread can't be detached; cancel the feature",
              ),
            );
          }
          if (!stage?.current) {
            return yield* Effect.fail(
              new FeatureValidationError("This thread is not a feature's current stage"),
            );
          }
          return yield* detach(stage.featureId);
        }).pipe(ownership.withPermits(1)),
      reopen: ({ id, projectId, requestId, actorId, stepId }) =>
        Effect.gen(function* () {
          const feature = yield* requireFeature(id, projectId);
          // Reopening reattaches a detached thread, unless it has since joined another feature.
          const state = yield* workflows.getFeatureState(id);
          const stopped = state?.stoppedStepId ? state.steps.get(state.stoppedStepId) : undefined;
          if (state?.cancelled && stopped?.threadId) {
            const { stage } = yield* threadLink(projectId, stopped.threadId);
            if (stage?.current && stage.featureId !== id) {
              return yield* Effect.fail(
                new FeatureValidationError("This feature's thread is now another feature's stage"),
              );
            }
          }
          if (feature.status === "closed") {
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            yield* sql`UPDATE features SET status = 'open', updated_at = ${updatedAt}
              WHERE id = ${id} AND project_id = ${projectId}`.pipe(Effect.mapError(queryError));
          }
          return yield* execution.control({
            featureId: id,
            projectId,
            requestId,
            actorId,
            kind: "reopened",
            ...(stepId === undefined ? {} : { stepId }),
          });
        }).pipe(ownership.withPermits(1)),
      get,
      setStatus: (id, projectId, status) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const feature = yield* get(id);
              if (!feature || feature.projectId !== projectId) {
                return yield* Effect.fail(
                  new FeatureValidationError("Feature not found in project"),
                );
              }
              if (status !== "open" && status !== "closed") {
                return yield* Effect.fail(new FeatureValidationError("Invalid feature status"));
              }
              if (feature.status === status) return feature;
              if (status === "closed") {
                const workflow = yield* workflows.getFeatureState(id);
                if (
                  workflow &&
                  ((yield* executions.get(id)) !== null || workflow.executionCount > 0) &&
                  !workflow.completed &&
                  !workflow.cancelled
                ) {
                  return yield* Effect.fail(
                    new FeatureValidationError(
                      "Finish or cancel the workflow before closing the feature",
                    ),
                  );
                }
              }
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`UPDATE features SET status = ${status}, updated_at = ${updatedAt}
            WHERE id = ${id} AND project_id = ${projectId}`;
              return { ...feature, status, updatedAt };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) })),
      listByProject: (projectId) =>
        sql<FeatureRow>`
          SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
            f.updated_at AS updatedAt, f.status, w.workflow_id AS workflowId,
          w.workflow_revision AS workflowRevision,
            f.bot_assignments_json AS botAssignmentsJson
          FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
          WHERE f.project_id = ${projectId}
          ORDER BY f.created_at DESC, f.id DESC
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
        ),
      create,
    });
  }),
);
