// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type ProjectId,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BotService, type BotServiceError } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
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

    return FeatureService.of({
      start: (id, projectId) =>
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
        }),
      reopen: ({ id, projectId, requestId, actorId, stepId }) =>
        Effect.gen(function* () {
          const feature = yield* requireFeature(id, projectId);
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
        }),
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
            f.bot_assignments_json AS botAssignmentsJson
          FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
          WHERE f.project_id = ${projectId}
          ORDER BY f.created_at DESC, f.id DESC
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
        ),
      create: (input) =>
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
                  botAssignments,
                  createdAt,
                  updatedAt: createdAt,
                  status: "open" as const,
                };
              }),
            )
            .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
        }),
    });
  }),
);
