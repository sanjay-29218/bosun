import {
  ProjectId,
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
  WorkflowStepEvent,
  type WorkflowStepEvent as WorkflowStepEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface FeatureWorkflowCopy {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly definition: WorkflowDefinitionType;
  readonly eventVersion: number;
  readonly createdAt: string;
}

interface DefinitionRow {
  readonly definitionJson: string;
}

interface FeatureCopyRow extends DefinitionRow {
  readonly featureId: string;
  readonly projectId: string;
  readonly eventVersion: number;
  readonly createdAt: string;
}

interface EventRow {
  readonly eventJson: string;
}

export type AppendWorkflowEventResult =
  | { readonly kind: "inserted"; readonly event: WorkflowStepEventType }
  | { readonly kind: "duplicate"; readonly event: WorkflowStepEventType }
  | { readonly kind: "conflict" };

export interface WorkflowStoreShape {
  readonly subscribeChanges: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
  readonly getExecutionStatus: (featureId: string) => Effect.Effect<
    {
      readonly lastError: string | null;
      readonly queuedAt: string | null;
    } | null,
    PersistenceSqlError
  >;
  readonly createDefinition: (
    definition: WorkflowDefinitionType,
    createdAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly updateDefinition: (
    definition: WorkflowDefinitionType,
    expectedRevision: number,
    createdAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getDefinition: (
    id: string,
    revision: number,
  ) => Effect.Effect<WorkflowDefinitionType | null, PersistenceSqlError>;
  readonly getLatestDefinition: (
    id: string,
  ) => Effect.Effect<WorkflowDefinitionType | null, PersistenceSqlError>;
  readonly listLatestDefinitions: () => Effect.Effect<
    ReadonlyArray<WorkflowDefinitionType>,
    PersistenceSqlError
  >;
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
  /** Open features started on the workflow; whether each is still running is the caller's call. */
  readonly listOpenFeaturesUsing: (
    workflowId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly title: string }>,
    PersistenceSqlError
  >;
  /** Names of the bots whose features start on the workflow. */
  readonly listBotsDefaultingTo: (
    workflowId: string,
  ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  /**
   * Removes the workflow and its versions from the library. Features keep the copy they started
   * with, so they are unaffected. False when there was no such workflow.
   */
  readonly deleteDefinition: (id: string) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly listEvents: (
    featureId: string,
  ) => Effect.Effect<ReadonlyArray<WorkflowStepEventType>, PersistenceSqlError>;
  readonly appendEvent: (
    featureId: string,
    expectedVersion: number,
    event: WorkflowStepEventType,
  ) => Effect.Effect<AppendWorkflowEventResult, PersistenceSqlError>;
}

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreShape>()(
  "t3/workflows/WorkflowStore",
) {}

const definitionJson = Schema.fromJsonString(WorkflowDefinition);
const encodeDefinition = Schema.encodeSync(definitionJson);
const decodeDefinition = (row: DefinitionRow) =>
  Schema.decodeSync(definitionJson)(row.definitionJson);
const eventJson = Schema.fromJsonString(WorkflowStepEvent);
const encodeEvent = Schema.encodeSync(eventJson);
const decodeEvent = (row: EventRow) => Schema.decodeSync(eventJson)(row.eventJson);
const decodeCopy = (row: FeatureCopyRow): FeatureWorkflowCopy => ({
  featureId: row.featureId,
  projectId: ProjectId.make(row.projectId),
  definition: decodeDefinition(row),
  eventVersion: row.eventVersion,
  createdAt: row.createdAt,
});

export const WorkflowStoreLive = Layer.effect(
  WorkflowStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<string>();
    const queryError = toPersistenceSqlError("WorkflowStore.query");
    const decodeError = toPersistenceSqlError("WorkflowStore.decode");

    const getDefinition: WorkflowStoreShape["getDefinition"] = (id, revision) =>
      sql<DefinitionRow>`
        SELECT definition_json AS definitionJson FROM workflow_definition_revisions
        WHERE id = ${id} AND revision = ${revision}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeDefinition(rows[0]) : null),
            catch: decodeError,
          }),
        ),
      );

    const getLatestDefinition: WorkflowStoreShape["getLatestDefinition"] = (id) =>
      sql<DefinitionRow>`
        SELECT r.definition_json AS definitionJson
        FROM workflow_definition_revisions AS r
        JOIN workflow_definition_heads AS h ON h.id = r.id AND h.revision = r.revision
        WHERE h.id = ${id}
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
          definition_json AS definitionJson, event_version AS eventVersion,
          created_at AS createdAt
        FROM feature_workflows WHERE feature_id = ${featureId}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({ try: () => (rows[0] ? decodeCopy(rows[0]) : null), catch: decodeError }),
        ),
      );

    return WorkflowStore.of({
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      getExecutionStatus: Effect.fn("WorkflowStore.getExecutionStatus")((featureId) =>
        sql<{ readonly lastError: string | null; readonly queuedAt: string | null }>`
        SELECT last_error AS lastError, queued_at AS queuedAt
        FROM workflow_executions WHERE feature_id = ${featureId}
      `.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => rows[0] ?? null),
        ),
      ),
      createDefinition: Effect.fn("WorkflowStore.createDefinition")((definition, createdAt) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* sql<{ readonly id: string }>`
                INSERT OR IGNORE INTO workflow_definition_heads (id, revision)
                VALUES (${definition.id}, ${definition.revision})
                RETURNING id
              `;
              if (inserted.length === 0) return false;
              yield* sql`
                INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
                VALUES (${definition.id}, ${definition.revision},
                  ${encodeDefinition(definition)}, ${createdAt})
              `;
              return true;
            }),
          )
          .pipe(Effect.mapError(queryError)),
      ),
      updateDefinition: Effect.fn("WorkflowStore.updateDefinition")(
        (definition, expectedRevision, createdAt) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const updated = yield* sql<{ readonly id: string }>`
                UPDATE workflow_definition_heads SET revision = ${definition.revision}
                WHERE id = ${definition.id} AND revision = ${expectedRevision}
                RETURNING id
              `;
                if (updated.length === 0) return false;
                yield* sql`
                INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
                VALUES (${definition.id}, ${definition.revision},
                  ${encodeDefinition(definition)}, ${createdAt})
              `;
                return true;
              }),
            )
            .pipe(Effect.mapError(queryError)),
      ),
      listOpenFeaturesUsing: Effect.fn("WorkflowStore.listOpenFeaturesUsing")((workflowId) =>
        sql<{ readonly id: string; readonly title: string }>`
          SELECT f.id, f.title FROM feature_workflows AS w
          JOIN features AS f ON f.id = w.feature_id
          WHERE w.workflow_id = ${workflowId} AND f.status = 'open'
          ORDER BY f.created_at, f.id
        `.pipe(Effect.mapError(queryError)),
      ),
      listBotsDefaultingTo: Effect.fn("WorkflowStore.listBotsDefaultingTo")((workflowId) =>
        sql<{ readonly name: string }>`
          SELECT name FROM bots
          WHERE default_workflow_id = ${workflowId} AND deleted_at IS NULL
          ORDER BY position, id
        `.pipe(
          Effect.map((rows) => rows.map((row) => row.name)),
          Effect.mapError(queryError),
        ),
      ),
      deleteDefinition: Effect.fn("WorkflowStore.deleteDefinition")((id) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM workflow_definition_revisions WHERE id = ${id}`;
              const deleted = yield* sql<{ readonly id: string }>`
                DELETE FROM workflow_definition_heads WHERE id = ${id} RETURNING id
              `;
              return deleted.length > 0;
            }),
          )
          .pipe(Effect.mapError(queryError)),
      ),
      getDefinition,
      getLatestDefinition,
      listLatestDefinitions: Effect.fn("WorkflowStore.listLatestDefinitions")(() =>
        sql<DefinitionRow>`
          SELECT r.definition_json AS definitionJson
          FROM workflow_definition_revisions AS r
          JOIN workflow_definition_heads AS h ON h.id = r.id AND h.revision = r.revision
          ORDER BY h.id
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({ try: () => rows.map(decodeDefinition), catch: decodeError }),
          ),
        ),
      ),
      copyForFeature: Effect.fn("WorkflowStore.copyForFeature")(
        (featureId, projectId, workflowId, revision, createdAt) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const definition = yield* getDefinition(workflowId, revision);
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
      ),
      getFeatureCopy,
      listEvents: Effect.fn("WorkflowStore.listEvents")((featureId) =>
        sql<EventRow>`
          SELECT event_json AS eventJson FROM workflow_step_events
          WHERE feature_id = ${featureId} ORDER BY sequence LIMIT 4097
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => {
                if (rows.length > 4096) throw new Error("Workflow history is too large");
                return rows.map(decodeEvent);
              },
              catch: decodeError,
            }),
          ),
        ),
      ),
      appendEvent: Effect.fn("WorkflowStore.appendEvent")((featureId, expectedVersion, event) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<EventRow>`
                SELECT event_json AS eventJson FROM workflow_step_events
                WHERE feature_id = ${featureId} AND event_id = ${event.id}
              `;
              if (existing[0]) {
                return { kind: "duplicate" as const, event: decodeEvent(existing[0]) };
              }
              const updated = yield* sql<{ readonly eventVersion: number }>`
                UPDATE feature_workflows SET event_version = event_version + 1
                WHERE feature_id = ${featureId} AND event_version = ${expectedVersion}
                RETURNING event_version AS eventVersion
              `;
              if (updated.length === 0) return { kind: "conflict" as const };
              yield* sql`
                INSERT INTO workflow_step_events (feature_id, event_id, event_json, occurred_at)
                VALUES (${featureId}, ${event.id}, ${encodeEvent(event)}, ${event.occurredAt})
              `;
              return { kind: "inserted" as const, event };
            }),
          )
          .pipe(
            Effect.mapError(queryError),
            Effect.tap((result) =>
              result.kind === "inserted" ? PubSub.publish(changes, featureId) : Effect.void,
            ),
          ),
      ),
    });
  }),
);
