import { WorkflowStageHandoff } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/** Handoff records are written once, before their stage is dispatched, and never change. */
export class WorkflowStageHandoffStore extends Context.Service<
  WorkflowStageHandoffStore,
  {
    readonly insertIfAbsent: (
      record: WorkflowStageHandoff,
    ) => Effect.Effect<WorkflowStageHandoff, PersistenceSqlError>;
    readonly get: (id: string) => Effect.Effect<WorkflowStageHandoff | null, PersistenceSqlError>;
    /** Features created without a feature record (tests, older data) have no brief. */
    readonly getFeatureBrief: (featureId: string) => Effect.Effect<string, PersistenceSqlError>;
  }
>()("t3/workflows/WorkflowStageHandoffStore") {}

const recordJson = Schema.fromJsonString(WorkflowStageHandoff);
const encodeRecord = Schema.encodeSync(recordJson);
const decodeRecord = Schema.decodeSync(recordJson);

export const WorkflowStageHandoffStoreLive = Layer.effect(
  WorkflowStageHandoffStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queryError = toPersistenceSqlError("WorkflowStageHandoffStore.query");
    const decodeError = toPersistenceSqlError("WorkflowStageHandoffStore.decode");
    const get = (id: string) =>
      sql<{ readonly recordJson: string }>`
        SELECT record_json AS recordJson FROM workflow_stage_handoffs WHERE id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeRecord(rows[0].recordJson) : null),
            catch: decodeError,
          }),
        ),
      );
    return WorkflowStageHandoffStore.of({
      get,
      insertIfAbsent: (record) =>
        sql`
          INSERT OR IGNORE INTO workflow_stage_handoffs
            (id, feature_id, step_id, execution_id, attempt, record_json, created_at)
          VALUES (${record.id}, ${record.featureId}, ${record.stepId}, ${record.executionId},
            ${record.attempt}, ${encodeRecord(record)}, ${record.createdAt})
        `.pipe(
          Effect.mapError(queryError),
          Effect.andThen(get(record.id)),
          Effect.flatMap((persisted) =>
            persisted
              ? Effect.succeed(persisted)
              : Effect.fail(queryError(new Error("Stage handoff was not persisted"))),
          ),
        ),
      getFeatureBrief: (featureId) =>
        sql<{ readonly brief: string }>`SELECT brief FROM features WHERE id = ${featureId}`.pipe(
          Effect.mapError(queryError),
          Effect.map((rows) => rows[0]?.brief ?? ""),
        ),
    });
  }),
);
