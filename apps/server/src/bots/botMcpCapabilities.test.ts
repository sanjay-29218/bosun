import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { botMcpCapabilities } from "./botMcpCapabilities.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("bot MCP grants", (it) => {
  it.effect("uses saved tool grants without granting ordinary thread defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE bot_runs (thread_id TEXT, allowed_tools_json TEXT)`;
      yield* sql`INSERT INTO bot_runs VALUES ('bot-run:builder', '["bots.delegate","worktree"]'),
        ('bosun-run:restricted', '[]'), ('bot-run:malformed', 'invalid')`;
      assert.deepStrictEqual(yield* botMcpCapabilities(ThreadId.make("ordinary")), undefined);
      assert.deepStrictEqual(
        yield* botMcpCapabilities(ThreadId.make("bot-run:builder")),
        new Set(["bots", "worktree"]),
      );
      for (const id of ["bosun-run:restricted", "bot-run:malformed", "bot-run:missing"]) {
        assert.deepStrictEqual(yield* botMcpCapabilities(ThreadId.make(id)), new Set());
      }
    }),
  );
});
