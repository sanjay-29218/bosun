import * as NodeCrypto from "node:crypto";

import { type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BotService, type BotServiceError } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export interface FeatureRecord {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly brief: string;
  readonly createdAt: string;
}

export interface CreateFeatureInput {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly brief: string;
}

export type FeatureServiceError = FeatureValidationError | BotServiceError | PersistenceSqlError;

export interface FeatureServiceShape {
  readonly create: (input: CreateFeatureInput) => Effect.Effect<FeatureRecord, FeatureServiceError>;
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

export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* BotService;
    const botStore = yield* BotStore;
    const runtime = yield* BotThreadRuntime;
    const queryError = toPersistenceSqlError("FeatureService.query");

    const get: FeatureServiceShape["get"] = (id) =>
      sql<FeatureRecord>`
        SELECT id, project_id AS projectId, title, brief, created_at AS createdAt
        FROM features WHERE id = ${id}
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(queryError),
      );

    return FeatureService.of({
      get,
      listByProject: (projectId) =>
        sql<FeatureRecord>`
          SELECT id, project_id AS projectId, title, brief, created_at AS createdAt
          FROM features WHERE project_id = ${projectId}
          ORDER BY created_at DESC, id DESC
        `.pipe(Effect.mapError(queryError)),
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
                    existing.brief !== input.brief
                  ) {
                    return yield* Effect.fail(
                      new FeatureValidationError("Feature ID belongs to another request"),
                    );
                  }
                  return existing;
                }

                const templates = (yield* botStore.listTemplatesForProject(input.projectId)).filter(
                  (template) => template.enabled && template.autoCreateForFeature,
                );
                const managerId = `bot-manager:${input.projectId}`;
                const manager = yield* botStore.getDefinition(managerId);
                for (const [position, template] of templates.entries()) {
                  const id = featureBotId(input.id, template.id);
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
                  if (manager?.enabled && manager.projectId === input.projectId) {
                    yield* bots.setHierarchyParent(id, manager.id, position);
                    yield* bots.allowDelegation(manager.id, id);
                  }
                }
                const createdAt = DateTime.formatIso(yield* DateTime.now);
                yield* sql`
                INSERT INTO features (id, project_id, title, brief, created_at)
                VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt})
              `;
                return { ...input, createdAt };
              }),
            )
            .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(queryError(error))));
        }),
    });
  }),
);
