import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { crewMcpCapabilities as capabilitiesWith } from "./crewMcpCapabilities.ts";

const DEFAULTS: ReadonlySet<McpCapability> = new Set([
  "orchestration",
  "worktree",
  "pull-requests",
  "preview",
]);
const crewMcpCapabilities = (threadId: ThreadId) => capabilitiesWith(threadId, DEFAULTS);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("bot MCP grants", (it) => {
  it.effect("gives crew threads the ordinary defaults unless their grants limit them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE crew_runs (id TEXT, member_id TEXT, thread_id TEXT, allowed_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE bots (id TEXT, allowed_tools_json TEXT)`;
      yield* sql`INSERT INTO crew_runs VALUES
        ('builder', 'role', 'bot-run:builder', '["crew.respond"]'),
        ('limited', 'role', 'bot-run:limited', '["crew.respond","worktree","device"]'),
        ('bare', 'role', 'bosun-run:bare', '[]'),
        ('malformed', 'role', 'bot-run:malformed', 'invalid'),
        ('bot-hq:bot-captain', 'bot-captain', 'bot-run:bot-hq:bot-captain', '["preview"]'),
        ('captain-request', 'bot-captain', 'bot-run:captain-request', '["worktree"]')`;
      yield* sql`INSERT INTO bots VALUES ('bot-captain', '["crew.decide"]')`;
      assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make("ordinary")), DEFAULTS);
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:builder")),
        new Set([...DEFAULTS, "crew"]),
      );
      // A limit never adds a toolkit the environment turned off, such as devices here.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:limited")),
        new Set(["worktree", "crew"]),
      );
      // A bot's headquarters follows the bot's grants, not the ones saved on its run.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:bot-hq:bot-captain")),
        new Set([...DEFAULTS, "crew"]),
      );
      // The bot's other runs keep the grants saved when they started.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:captain-request")),
        new Set(["worktree"]),
      );
      for (const id of ["bosun-run:bare", "bot-run:malformed", "bot-run:missing"]) {
        assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make(id)), DEFAULTS);
      }
    }),
  );

  it.effect("holds a crew thread's subagents to its tools, without the crew tools", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS crew_runs
          (id TEXT, member_id TEXT, thread_id TEXT, allowed_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE IF NOT EXISTS bots (id TEXT, allowed_tools_json TEXT)`;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)
      `;
      yield* sql`INSERT INTO crew_runs VALUES
        ('stage', 'role', 'bot-run:stage', '["crew.respond","orchestration","worktree"]')`;
      const lineage = (parent: string, relationship: string) =>
        JSON.stringify({ lineage: { parentThreadId: parent, relationshipToParent: relationship } });
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES
        ('helper', ${lineage("bot-run:stage", "subagent")}),
        ('helper-of-helper', ${lineage("helper", "subagent")}),
        ('fork', ${lineage("bot-run:stage", "fork")}),
        ('plain-helper', ${lineage("ordinary", "subagent")})`;

      for (const id of ["helper", "helper-of-helper"]) {
        assert.deepStrictEqual(
          yield* crewMcpCapabilities(ThreadId.make(id)),
          new Set(["orchestration", "worktree"]),
        );
      }
      // A fork is a person's own thread, and a plain thread's helper keeps the defaults.
      for (const id of ["fork", "plain-helper"]) {
        assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make(id)), DEFAULTS);
      }
    }),
  );
});
