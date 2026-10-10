import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/** Feature supplies existing instances and the runs authorized to dispatch their work. */
export const WorkflowBindings = Schema.Record(
  Schema.String,
  Schema.Struct({
    botId: Schema.String,
    dispatchRunId: Schema.String,
  }),
);
export type WorkflowBindings = typeof WorkflowBindings.Type;

export interface WorkflowExecution {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly bindings: WorkflowBindings;
  readonly lastError: string | null;
  readonly settled: boolean;
  /** The feature's title and brief, when it was created through FeatureService. */
  readonly brief: { readonly title: string; readonly text: string } | null;
  /** Set while the feature waits for a stage slot. */
  readonly queuedAt: string | null;
  /** The provider instance whose slot it holds, or, while queued, the one it waits for. */
  readonly slotInstanceId: string | null;
}

/** One unsettled feature's place in the stage-thread limits. */
export interface WorkflowSlot {
  readonly featureId: string;
  readonly queuedAt: string | null;
  readonly slotInstanceId: string | null;
}

export class WorkflowExecutionStore extends Context.Service<
  WorkflowExecutionStore,
  {
    readonly attach: (
      featureId: string,
      bindings: WorkflowBindings,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly get: (
      featureId: string,
    ) => Effect.Effect<WorkflowExecution | null, PersistenceSqlError>;
    readonly listActive: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
    readonly findFeatureForHandoff: (
      handoffId: string,
    ) => Effect.Effect<string | null, PersistenceSqlError>;
    /** Features this thread was ever attached to as a stage thread, newest first. */
    readonly findFeaturesForThread: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
    readonly update: (
      featureId: string,
      lastError: string | null,
      settled: boolean,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly listSlots: () => Effect.Effect<ReadonlyArray<WorkflowSlot>, PersistenceSqlError>;
    readonly setSlot: (
      featureId: string,
      queuedAt: string | null,
      slotInstanceId: string | null,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /** The stage summary last written to each of the feature's threads, as JSON. */
    readonly listStageThreads: (
      featureId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, PersistenceSqlError>;
    /** Settled features with a stage thread still showing a state they have left. */
    readonly listUnsyncedSettledFeatures: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
    readonly setStageThread: (
      threadId: string,
      featureId: string,
      summaryJson: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/workflows/WorkflowExecutionStore") {}

const bindingsJson = Schema.fromJsonString(WorkflowBindings);
const encodeBindings = Schema.encodeSync(bindingsJson);
const decodeBindings = Schema.decodeSync(bindingsJson);

export const WorkflowExecutionStoreLive = Layer.effect(
  WorkflowExecutionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const error = toPersistenceSqlError("WorkflowExecutionStore.query");
    return WorkflowExecutionStore.of({
      findFeatureForHandoff: (handoffId) =>
        sql<{ readonly featureId: string }>`
        SELECT feature_id AS featureId FROM workflow_step_events
        WHERE json_extract(event_json, '$.kind') = 'started'
          AND json_extract(event_json, '$.sourceId') = ${handoffId}
        LIMIT 1
      `.pipe(
          Effect.mapError(error),
          Effect.map((rows) => rows[0]?.featureId ?? null),
        ),
      findFeaturesForThread: (threadId) =>
        sql<{ readonly featureId: string }>`
        SELECT feature_id AS featureId FROM workflow_step_events
        WHERE json_extract(event_json, '$.kind') = 'attached'
          AND json_extract(event_json, '$.threadId') = ${threadId}
        GROUP BY feature_id ORDER BY MAX(sequence) DESC
      `.pipe(
          Effect.mapError(error),
          Effect.map((rows) => rows.map((row) => row.featureId)),
        ),
      attach: (featureId, bindings) =>
        sql`
      INSERT OR IGNORE INTO workflow_executions (feature_id, bindings_json)
      VALUES (${featureId}, ${encodeBindings(bindings)})
    `.pipe(Effect.asVoid, Effect.mapError(error)),
      get: (featureId) =>
        sql<{
          readonly featureId: string;
          readonly projectId: string;
          readonly bindingsJson: string;
          readonly lastError: string | null;
          readonly settled: number;
          readonly title: string | null;
          readonly brief: string | null;
          readonly queuedAt: string | null;
          readonly slotInstanceId: string | null;
        }>`
      SELECT e.feature_id AS featureId, w.project_id AS projectId,
        e.bindings_json AS bindingsJson, e.last_error AS lastError, e.settled,
        f.title, f.brief, e.queued_at AS queuedAt, e.slot_instance_id AS slotInstanceId
      FROM workflow_executions AS e JOIN feature_workflows AS w ON w.feature_id = e.feature_id
      LEFT JOIN features AS f ON f.id = e.feature_id
      WHERE e.feature_id = ${featureId}
    `.pipe(
          Effect.mapError(error),
          Effect.flatMap((rows) =>
            Effect.try({
              try: () =>
                rows[0]
                  ? {
                      featureId: rows[0].featureId,
                      projectId: ProjectId.make(rows[0].projectId),
                      bindings: decodeBindings(rows[0].bindingsJson),
                      lastError: rows[0].lastError,
                      settled: rows[0].settled === 1,
                      brief:
                        rows[0].title === null
                          ? null
                          : { title: rows[0].title, text: rows[0].brief ?? "" },
                      queuedAt: rows[0].queuedAt,
                      slotInstanceId: rows[0].slotInstanceId,
                    }
                  : null,
              catch: error,
            }),
          ),
        ),
      listActive: (projectId) =>
        sql<{ readonly featureId: string }>`
      SELECT e.feature_id AS featureId FROM workflow_executions AS e
      JOIN feature_workflows AS w ON w.feature_id = e.feature_id
      WHERE e.settled = 0 ${projectId === undefined ? sql`` : sql`AND w.project_id = ${projectId}`}
      ORDER BY e.feature_id
    `.pipe(
          Effect.mapError(error),
          Effect.map((rows) => rows.map((row) => row.featureId)),
        ),
      update: (featureId, lastError, settled) =>
        sql`
      UPDATE workflow_executions SET last_error = ${lastError}, settled = ${settled ? 1 : 0}
      WHERE feature_id = ${featureId}
    `.pipe(Effect.asVoid, Effect.mapError(error)),
      listSlots: () =>
        sql<WorkflowSlot>`
      SELECT feature_id AS featureId, queued_at AS queuedAt, slot_instance_id AS slotInstanceId
      FROM workflow_executions
      WHERE settled = 0 AND (queued_at IS NOT NULL OR slot_instance_id IS NOT NULL)
      ORDER BY queued_at, feature_id
    `.pipe(Effect.mapError(error)),
      setSlot: (featureId, queuedAt, slotInstanceId) =>
        sql`
      UPDATE workflow_executions SET queued_at = ${queuedAt}, slot_instance_id = ${slotInstanceId}
      WHERE feature_id = ${featureId}
    `.pipe(Effect.asVoid, Effect.mapError(error)),
      listStageThreads: (featureId) =>
        sql<{ readonly threadId: string; readonly summaryJson: string }>`
      SELECT thread_id AS threadId, summary_json AS summaryJson
      FROM crew_stage_threads WHERE feature_id = ${featureId}
    `.pipe(
          Effect.mapError(error),
          Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row.summaryJson]))),
        ),
      listUnsyncedSettledFeatures: (projectId) =>
        sql<{ readonly featureId: string }>`
      SELECT DISTINCT s.feature_id AS featureId FROM crew_stage_threads AS s
      JOIN workflow_executions AS e ON e.feature_id = s.feature_id
      JOIN feature_workflows AS w ON w.feature_id = s.feature_id
      WHERE e.settled = 1
        AND json_extract(s.summary_json, '$.current') = 1
        AND json_extract(s.summary_json, '$.state') NOT IN ('done', 'cancelled')
        ${projectId === undefined ? sql`` : sql`AND w.project_id = ${projectId}`}
    `.pipe(
          Effect.mapError(error),
          Effect.map((rows) => rows.map((row) => row.featureId)),
        ),
      setStageThread: (threadId, featureId, summaryJson) =>
        sql`
      INSERT INTO crew_stage_threads (thread_id, feature_id, summary_json)
      VALUES (${threadId}, ${featureId}, ${summaryJson})
      ON CONFLICT (thread_id) DO UPDATE SET
        feature_id = excluded.feature_id, summary_json = excluded.summary_json
    `.pipe(Effect.asVoid, Effect.mapError(error)),
    });
  }),
);
