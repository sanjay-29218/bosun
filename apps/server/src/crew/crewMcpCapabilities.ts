import {
  BOT_HEADQUARTERS_RUN_PREFIX,
  grantedTools,
  PROJECT_HEADQUARTERS_RUN_PREFIX,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

const MANAGE_CREW = "crew.workflows";

const decodeWithheld = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const isCrewThread = (threadId: string) =>
  threadId.startsWith("bot-run:") || threadId.startsWith("bosun-run:");

/**
 * The tools a crew thread's run holds. Standing threads use their owner's current withheld list:
 * a bot's headquarters its bot's, a project's manager its member's. Bot-only grants go to runs a
 * bot acts in. An unreadable list withholds only those.
 */
const runGrants = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly withheldTools: string; readonly bot: number }>`
    SELECT COALESCE(b.withheld_tools_json, m.withheld_tools_json, r.withheld_tools_json)
        AS withheldTools,
      EXISTS (SELECT 1 FROM bots WHERE bots.id = r.member_id) AS bot
    FROM crew_runs AS r
    LEFT JOIN bots AS b
      ON r.id LIKE ${`${BOT_HEADQUARTERS_RUN_PREFIX}%`} AND b.id = r.member_id
    LEFT JOIN crew_members AS m
      ON r.id LIKE ${`${PROJECT_HEADQUARTERS_RUN_PREFIX}%`} AND m.id = r.member_id
    WHERE r.thread_id = ${threadId}
  `.pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) => {
      const bot = rows[0]?.bot === 1;
      return decodeWithheld(rows[0]?.withheldTools ?? "[]").pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => (bot ? [MANAGE_CREW] : [])),
        Effect.map((withheld) => grantedTools(withheld, { bot })),
      );
    }),
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

/**
 * A crew thread gets the T3 toolkits an ordinary thread gets (`defaults`) that it wasn't denied,
 * plus `crew`, whose tools each check their own grant. Its subagents don't get `crew`: they
 * aren't crew members.
 */
export const crewMcpCapabilities = Effect.fn("crewMcpCapabilities")(function* (
  threadId: ThreadId,
  defaults: ReadonlySet<McpCapability>,
) {
  const grants = yield* crewThreadGrants(threadId);
  if (grants === undefined) return defaults;
  const capabilities = new Set<McpCapability>(
    [...defaults].filter((capability) => grants.includes(capability)),
  );
  if (isCrewThread(threadId)) capabilities.add("crew");
  return capabilities;
});
