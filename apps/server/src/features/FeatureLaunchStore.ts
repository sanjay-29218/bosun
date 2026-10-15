import { type FeatureLaunchRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export type FeatureLaunch = typeof FeatureLaunchRecord.Type;
export class FeatureLaunchStore extends Context.Service<
  FeatureLaunchStore,
  {
    readonly get: (featureId: string) => Effect.Effect<FeatureLaunch | null, PersistenceSqlError>;
    readonly reserve: (launch: FeatureLaunch) => Effect.Effect<void, PersistenceSqlError>;
    readonly update: (
      featureId: string,
      phase: FeatureLaunch["phase"],
      lastError: string | null,
      updatedAt: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly listActive: (
      afterId: string,
    ) => Effect.Effect<ReadonlyArray<FeatureLaunch>, PersistenceSqlError>;
  }
>()("t3/features/FeatureLaunchStore") {}

export const FeatureLaunchStoreLive = Layer.effect(
  FeatureLaunchStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const error = toPersistenceSqlError("FeatureLaunchStore.query");
    const rows = (featureId: string | null, afterId = "") =>
      sql<FeatureLaunch>`
    SELECT feature_id AS featureId, project_id AS projectId, source_run_id AS sourceRunId,
      actor_id AS actorId, phase, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
    FROM feature_launches
    WHERE (${featureId} IS NULL AND phase IN ('pending', 'attached') AND feature_id > ${afterId}) OR feature_id = ${featureId}
    ORDER BY feature_id LIMIT 100
  `.pipe(Effect.mapError(error));
    return FeatureLaunchStore.of({
      get: (id) => rows(id).pipe(Effect.map((items) => items[0] ?? null)),
      listActive: (afterId) => rows(null, afterId),
      reserve: (launch) =>
        sql`INSERT OR IGNORE INTO feature_launches
      (feature_id, project_id, source_run_id, actor_id, phase, last_error, created_at, updated_at)
      VALUES (${launch.featureId}, ${launch.projectId}, ${launch.sourceRunId}, ${launch.actorId},
        ${launch.phase}, ${launch.lastError}, ${launch.createdAt}, ${launch.updatedAt})`.pipe(
          Effect.asVoid,
          Effect.mapError(error),
        ),
      update: (id, phase, lastError, updatedAt) =>
        sql`UPDATE feature_launches
      SET phase = ${phase}, last_error = ${lastError}, updated_at = ${updatedAt}
      WHERE feature_id = ${id}`.pipe(Effect.asVoid, Effect.mapError(error)),
    });
  }),
);
