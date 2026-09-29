import {
  ProjectId,
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface FeatureWorkflowCopy {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly definition: WorkflowDefinitionType;
  readonly createdAt: string;
}

interface DefinitionRow {
  readonly definitionJson: string;
}

interface FeatureCopyRow extends DefinitionRow {
  readonly featureId: string;
  readonly projectId: string;
  readonly createdAt: string;
}

export interface WorkflowStoreShape {
  readonly createDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinitionType,
    createdAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly updateDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinitionType,
    expectedRevision: number,
    createdAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getDefinition: (
    projectId: ProjectId,
    id: string,
    revision: number,
  ) => Effect.Effect<WorkflowDefinitionType | null, PersistenceSqlError>;
  readonly getLatestDefinition: (
    projectId: ProjectId,
    id: string,
  ) => Effect.Effect<WorkflowDefinitionType | null, PersistenceSqlError>;
  readonly copyForFeature: (
    featureId: string,
    projectId: ProjectId,
    workflowId: string,
    revision: number,
    createdAt: string,
  ) => Effect.Effect<FeatureWorkflowCopy | null, PersistenceSqlError>;
  readonly getFeatureCopy: (
    featureId: string,
  ) => Effect.Effect<FeatureWorkflowCopy | null, PersistenceSqlError>;
}

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreShape>()(
  "t3/workflows/WorkflowStore",
) {}

const definitionJson = Schema.fromJsonString(WorkflowDefinition);
const encodeDefinition = Schema.encodeSync(definitionJson);
const decodeDefinition = (row: DefinitionRow) =>
  Schema.decodeSync(definitionJson)(row.definitionJson);
const decodeCopy = (row: FeatureCopyRow): FeatureWorkflowCopy => ({
  featureId: row.featureId,
  projectId: ProjectId.make(row.projectId),
  definition: decodeDefinition(row),
  createdAt: row.createdAt,
});

export const WorkflowStoreLive = Layer.effect(
  WorkflowStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queryError = toPersistenceSqlError("WorkflowStore.query");
    const decodeError = toPersistenceSqlError("WorkflowStore.decode");

    const getDefinition: WorkflowStoreShape["getDefinition"] = (projectId, id, revision) =>
      sql<DefinitionRow>`
        SELECT definition_json AS definitionJson FROM workflow_definition_revisions
        WHERE project_id = ${projectId} AND id = ${id} AND revision = ${revision}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeDefinition(rows[0]) : null),
            catch: decodeError,
          }),
        ),
      );

    const getLatestDefinition: WorkflowStoreShape["getLatestDefinition"] = (projectId, id) =>
      sql<DefinitionRow>`
        SELECT r.definition_json AS definitionJson
        FROM workflow_definition_revisions AS r
        JOIN workflow_definition_heads AS h
          ON h.project_id = r.project_id AND h.id = r.id AND h.revision = r.revision
        WHERE h.project_id = ${projectId} AND h.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeDefinition(rows[0]) : null),
            catch: decodeError,
          }),
        ),
      );

    const getFeatureCopy: WorkflowStoreShape["getFeatureCopy"] = (featureId) =>
      sql<FeatureCopyRow>`
        SELECT feature_id AS featureId, project_id AS projectId,
          definition_json AS definitionJson, created_at AS createdAt
        FROM feature_workflows WHERE feature_id = ${featureId}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeCopy(rows[0]) : null), catch: decodeError }),
        ),
      );

    return WorkflowStore.of({
      createDefinition: (projectId, definition, createdAt) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* sql<{ readonly id: string }>`
                INSERT OR IGNORE INTO workflow_definition_heads (project_id, id, revision)
                VALUES (${projectId}, ${definition.id}, ${definition.revision})
                RETURNING id
              `;
              if (inserted.length === 0) return false;
              yield* sql`
                INSERT INTO workflow_definition_revisions
                  (project_id, id, revision, definition_json, created_at)
                VALUES (${projectId}, ${definition.id}, ${definition.revision},
                  ${encodeDefinition(definition)}, ${createdAt})
              `;
              return true;
            }),
          )
          .pipe(Effect.mapError(queryError)),
      updateDefinition: (projectId, definition, expectedRevision, createdAt) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
                UPDATE workflow_definition_heads SET revision = ${definition.revision}
                WHERE project_id = ${projectId} AND id = ${definition.id}
                  AND revision = ${expectedRevision}
                RETURNING id
              `;
              if (updated.length === 0) return false;
              yield* sql`
                INSERT INTO workflow_definition_revisions
                  (project_id, id, revision, definition_json, created_at)
                VALUES (${projectId}, ${definition.id}, ${definition.revision},
                  ${encodeDefinition(definition)}, ${createdAt})
              `;
              return true;
            }),
          )
          .pipe(Effect.mapError(queryError)),
      getDefinition,
      getLatestDefinition,
      copyForFeature: (featureId, projectId, workflowId, revision, createdAt) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const definition = yield* getDefinition(projectId, workflowId, revision);
              if (definition === null) return null;
              yield* sql`
                INSERT OR IGNORE INTO feature_workflows
                  (feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at)
                VALUES (${featureId}, ${projectId}, ${workflowId}, ${definition.revision},
                  ${encodeDefinition(definition)}, ${createdAt})
              `;
              return yield* getFeatureCopy(featureId);
            }),
          )
          .pipe(Effect.mapError(queryError)),
      getFeatureCopy,
    });
  }),
);
