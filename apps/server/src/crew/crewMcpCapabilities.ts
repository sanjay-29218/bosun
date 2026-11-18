import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

const isCrewThread = (threadId: string) =>
  threadId.startsWith("bot-run:") || threadId.startsWith("bosun-run:");

/**
 * Whether `threadId` is a feature's crew member: a subagent with a member name whose parent is
 * a crew thread, its feature's lead, which delegated to it by name.
 */
export const isFeatureCrewMember = Effect.fn("isFeatureCrewMember")(function* (threadId: ThreadId) {
  if (isCrewThread(threadId)) return false;
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(database)) return false;
  return yield* database.value<{ readonly found: number }>`
    SELECT 1 AS found FROM orchestration_v2_projection_threads
    WHERE thread_id = ${threadId} AND json_valid(payload_json)
      AND json_extract(payload_json, '$.feature.member') IS NOT NULL
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND (
        json_extract(payload_json, '$.lineage.parentThreadId') LIKE 'bot-run:%'
        OR json_extract(payload_json, '$.lineage.parentThreadId') LIKE 'bosun-run:%'
      )
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Every bot, role and crew thread gets the T3 toolkits an ordinary thread gets (`defaults`), plus
 * `crew` for the crew run it acts for. Its subagents don't get `crew`: they aren't crew members.
 */
export const crewMcpCapabilities = (threadId: ThreadId, defaults: ReadonlySet<McpCapability>) =>
  isCrewThread(threadId) ? new Set<McpCapability>([...defaults, "crew"]) : defaults;
