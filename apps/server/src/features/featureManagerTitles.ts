import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";

/**
 * A feature's lead is titled after its manager, which was called "Project manager" before the
 * Feature manager rename. Open features' leads take the new name so they don't read as a
 * project's own manager; closed features keep their history. Fixed command IDs make it once.
 */
export const retitleFeatureManagerLeads = Effect.fn("FeatureService.retitleFeatureManagerLeads")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestratorV2;
    const leads = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT t.thread_id AS threadId
      FROM orchestration_v2_projection_threads t
      JOIN features f ON f.id = json_extract(t.payload_json, '$.feature.id')
      WHERE t.deleted_at IS NULL AND t.title = 'Project manager' AND f.status = 'open'
        AND t.thread_id LIKE 'bot-run:feature-lead:%'
    `;
    yield* Effect.forEach(
      leads,
      ({ threadId }) =>
        engine
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:system:feature-manager-title:${threadId}`),
            threadId,
            title: "Feature manager",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not retitle a feature lead", { threadId, cause }),
            ),
          ),
      { discard: true },
    );
  },
);
