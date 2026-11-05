import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";

/**
 * A feature's lead is titled after its feature. Leads started earlier carry their manager's
 * generic name, "Project manager" or "Feature manager", so open features' leads take their
 * feature's title; closed features keep their history. Fixed command IDs make it once.
 */
export const retitleFeatureManagerLeads = Effect.fn("FeatureService.retitleFeatureManagerLeads")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestratorV2;
    const leads = yield* sql<{ readonly threadId: ThreadId; readonly title: string }>`
      SELECT t.thread_id AS threadId, f.title AS title
      FROM orchestration_v2_projection_threads t
      JOIN features f ON f.id = json_extract(t.payload_json, '$.feature.id')
      WHERE t.deleted_at IS NULL AND f.status = 'open'
        AND t.title IN ('Project manager', 'Feature manager')
        AND t.thread_id LIKE 'bot-run:feature-lead:%'
    `;
    yield* Effect.forEach(
      leads,
      ({ threadId, title }) =>
        engine
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:system:feature-lead-title:${threadId}`),
            threadId,
            title,
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
