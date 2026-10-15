import { BOT_HEADQUARTERS_RUN_PREFIX, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

const decodeGrants = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * A crew thread's grants, or undefined for an ordinary thread. Crew threads use their run's saved
 * grants, and a bot's headquarters uses the bot's current ones.
 */
export const crewThreadGrants = Effect.fn("crewThreadGrants")(function* (threadId: ThreadId) {
  if (!threadId.startsWith("bot-run:") && !threadId.startsWith("bosun-run:")) return undefined;
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(database)) return [];
  const rows = yield* database.value<{ readonly allowedTools: string }>`
    SELECT COALESCE(b.allowed_tools_json, r.allowed_tools_json) AS allowedTools
    FROM crew_runs AS r
    LEFT JOIN bots AS b
      ON r.id LIKE ${`${BOT_HEADQUARTERS_RUN_PREFIX}%`} AND b.id = r.member_id
    WHERE r.thread_id = ${threadId}
  `.pipe(Effect.orElseSucceed(() => []));
  return yield* decodeGrants(rows[0]?.allowedTools ?? "[]").pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
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
