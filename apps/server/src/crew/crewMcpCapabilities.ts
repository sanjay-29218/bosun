import { BOT_HEADQUARTERS_RUN_PREFIX, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

const decodeGrants = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const isCrewThread = (threadId: string) =>
  threadId.startsWith("bot-run:") || threadId.startsWith("bosun-run:");

/** The grants saved on a crew thread's run; a bot's headquarters uses the bot's current ones. */
const runGrants = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly allowedTools: string }>`
    SELECT COALESCE(b.allowed_tools_json, r.allowed_tools_json) AS allowedTools
    FROM crew_runs AS r
    LEFT JOIN bots AS b
      ON r.id LIKE ${`${BOT_HEADQUARTERS_RUN_PREFIX}%`} AND b.id = r.member_id
    WHERE r.thread_id = ${threadId}
  `.pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) => decodeGrants(rows[0]?.allowedTools ?? "[]")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/** The nearest crew thread `threadId` descends from as a subagent, if any. */
const crewAncestor = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly threadId: string }>`
    WITH RECURSIVE up(thread_id, depth) AS (
      SELECT json_extract(payload_json, '$.lineage.parentThreadId'), 1
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND json_valid(payload_json)
        AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      UNION ALL
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), up.depth + 1
      FROM orchestration_v2_projection_threads AS t JOIN up ON t.thread_id = up.thread_id
      WHERE up.depth < 16 AND json_valid(t.payload_json)
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
    )
    SELECT thread_id AS threadId FROM up
    WHERE thread_id LIKE 'bot-run:%' OR thread_id LIKE 'bosun-run:%'
    ORDER BY depth LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.threadId),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * A crew thread's grants, or undefined for an ordinary thread. A crew thread's subagents, at any
 * depth, keep its T3 tool grants but not its crew ones, since they aren't crew members.
 */
export const crewThreadGrants = Effect.fn("crewThreadGrants")(function* (threadId: ThreadId) {
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (isCrewThread(threadId)) {
    return Option.isNone(database) ? [] : yield* runGrants(database.value, threadId);
  }
  if (Option.isNone(database)) return undefined;
  const ancestor = yield* crewAncestor(database.value, threadId);
  if (ancestor === undefined) return undefined;
  return (yield* runGrants(database.value, ancestor)).filter((grant) => !grant.startsWith("crew."));
});

/** Ordinary threads use the harness defaults; crew threads use their grants. */
export const crewMcpCapabilities = Effect.fn("crewMcpCapabilities")(function* (threadId: ThreadId) {
  const grants = yield* crewThreadGrants(threadId);
  if (grants === undefined) return undefined;
  const capabilities = new Set<McpCapability>();
  if (grants.some((grant) => grant.startsWith("crew."))) capabilities.add("crew");
  for (const capability of [
    "preview",
    "device",
    "pull-requests",
    "orchestration",
    "worktree",
  ] as const) {
    if (grants.includes(capability)) capabilities.add(capability);
  }
  return capabilities;
});
