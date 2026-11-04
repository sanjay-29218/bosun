import { CommandId, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";

/**
 * The retired workflow engine acted on the answers to the questions it opened (owner
 * "workflow"). A question it left pending has nothing to answer it, yet it still reads as
 * waiting on the person, so it's dismissed. Nothing opens these anymore.
 */
export const dismissRetiredWorkflowQuestions = Effect.fn(
  "CrewService.dismissRetiredWorkflowQuestions",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const questions = yield* sql<{
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  }>`
    SELECT thread_id AS threadId, runtime_request_id AS requestId
    FROM orchestration_v2_projection_runtime_requests
    WHERE status = 'pending' AND json_extract(payload_json, '$.owner') = 'workflow'
  `;
  yield* Effect.forEach(
    questions,
    (question) =>
      engine
        .dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make(
            `command:system:retired-workflow-question:${question.requestId}`,
          ),
          threadId: question.threadId,
          requestId: question.requestId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not dismiss a retired workflow question", {
              requestId: question.requestId,
              cause,
            }),
          ),
        ),
    { discard: true },
  );
});
