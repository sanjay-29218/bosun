import * as NodeCrypto from "node:crypto";

import {
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BotService, type BotServiceError } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkflowService, type WorkflowServiceError } from "../workflows/WorkflowService.ts";
import { WorkflowExecutionStore } from "../workflows/WorkflowExecutionStore.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { featureWriter } from "./FeatureWriterLease.ts";
import { FeatureLaunchStore } from "./FeatureLaunchStore.ts";

export class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export type FeatureRecord = typeof FeatureRecordSchema.Type;
export type CreateFeatureInput = typeof FeatureCreateInput.Type & { readonly actorId?: string };

export type FeatureServiceError =
  | FeatureValidationError
  | BotServiceError
  | PersistenceSqlError
  | WorkflowServiceError;

export interface FeatureServiceShape {
  readonly create: (input: CreateFeatureInput) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly setStatus: (
    id: string,
    projectId: ProjectId,
    status: FeatureRecord["status"],
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly get: (id: string) => Effect.Effect<FeatureRecord | null, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureRecord>, PersistenceSqlError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()(
  "t3/features/FeatureService",
) {}

const validText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

const featureBotId = (featureId: string, templateId: string) =>
  `feature-bot:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([featureId, templateId]))
    .digest("hex")
    .slice(0, 32)}`;

const assignmentsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeAssignments = Schema.encodeSync(assignmentsJson);
const decodeAssignments = Schema.decodeSync(assignmentsJson);
interface FeatureRow extends Omit<FeatureRecord, "botAssignments"> {
  readonly botAssignmentsJson: string;
}

export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const background = yield* ThreadBackgroundLivenessService;
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* BotService;
    const botStore = yield* BotStore;
    const runtime = yield* BotThreadRuntime;
    const workflows = yield* WorkflowService;
    const executions = yield* WorkflowExecutionStore;
    const launches = yield* FeatureLaunchStore;
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
          f.owner_id AS ownerId, f.bot_assignments_json AS botAssignmentsJson
        FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
        WHERE f.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => (rows[0] ? decodeRow(rows[0]) : Effect.succeed(null))),
      );

    return FeatureService.of({
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
                const checkout = yield* sql<{
                  path: string | null;
                  phase: string;
                  mode: string;
                }>`SELECT path, phase, mode FROM feature_checkouts WHERE feature_id = ${id}`;
                if (
                  checkout[0]?.phase === "pending" ||
                  (checkout[0]?.mode === "worktree" &&
                    checkout[0].path &&
                    (yield* featureWriter(checkout[0].path).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                      Effect.provideService(ThreadBackgroundLivenessService, background),
                    )))
                )
                  return yield* Effect.fail(
                    new FeatureValidationError(
                      "Wait for checkout setup and its writer to finish before closing the feature",
                    ),
                  );
                const workflow = yield* workflows.getFeatureState(id);
                if (
                  workflow &&
                  ((yield* launches.get(id))?.phase === "pending" ||
                    (yield* executions.get(id)) !== null ||
                    workflow.executionCount > 0) &&
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
          .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(queryError(error)))),
      listByProject: (projectId) =>
        sql<FeatureRow>`
          SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
            f.updated_at AS updatedAt, f.status, w.workflow_id AS workflowId,
            f.owner_id AS ownerId, f.bot_assignments_json AS botAssignmentsJson
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
                INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, bot_assignments_json, owner_id)
                VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt}, ${createdAt}, 'open', ${encodeAssignments(botAssignments)}, ${input.actorId ?? null})
              `;
                return {
                  ...input,
                  ownerId: input.actorId ?? null,
                  workflowId: input.workflowId ?? null,
                  botAssignments,
                  createdAt,
                  updatedAt: createdAt,
                  status: "open" as const,
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(queryError(error))));
        }),
    });
  }),
);
