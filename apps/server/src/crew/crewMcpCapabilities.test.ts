import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { crewMcpCapabilities } from "./crewMcpCapabilities.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("bot MCP grants", (it) => {
  it.effect("uses saved tool grants without granting ordinary thread defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE crew_runs (id TEXT, member_id TEXT, thread_id TEXT, allowed_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE bots (id TEXT, allowed_tools_json TEXT)`;
      yield* sql`INSERT INTO crew_runs VALUES
        ('builder', 'role', 'bot-run:builder', '["crew.delegate","worktree"]'),
        ('restricted', 'role', 'bosun-run:restricted', '[]'),
        ('malformed', 'role', 'bot-run:malformed', 'invalid'),
        ('bot-hq:bot-captain', 'bot-captain', 'bot-run:bot-hq:bot-captain', '[]'),
        ('captain-request', 'bot-captain', 'bot-run:captain-request', '["worktree"]')`;
      yield* sql`INSERT INTO bots VALUES ('bot-captain', '["crew.projects","preview"]')`;
      assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make("ordinary")), undefined);
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:builder")),
        new Set(["crew", "worktree"]),
      );
      // A bot's headquarters follows the bot's grants, not the ones saved on its run.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:bot-hq:bot-captain")),
        new Set(["crew", "preview"]),
      );
      // The bot's other runs keep the grants saved when they started.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:captain-request")),
        new Set(["worktree"]),
      );
      for (const id of ["bosun-run:restricted", "bot-run:malformed", "bot-run:missing"]) {
        assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make(id)), new Set());
      }
    }),
  );
});
