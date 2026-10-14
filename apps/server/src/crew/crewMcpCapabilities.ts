import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

const decodeGrants = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Ordinary threads use the harness defaults; crew threads use their run's saved grants. */
export const crewMcpCapabilities = Effect.fn("crewMcpCapabilities")(function* (threadId: ThreadId) {
  if (!threadId.startsWith("bot-run:") && !threadId.startsWith("bosun-run:")) return undefined;
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(database)) return new Set<McpCapability>();
  const rows = yield* database.value<{ readonly allowedTools: string }>`
    SELECT allowed_tools_json AS allowedTools FROM crew_runs WHERE thread_id = ${threadId}
  `.pipe(Effect.orElseSucceed(() => []));
  const grants = yield* decodeGrants(rows[0]?.allowedTools ?? "[]").pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
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
