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
      yield* sql`CREATE TABLE crew_runs (thread_id TEXT, allowed_tools_json TEXT)`;
      yield* sql`INSERT INTO crew_runs VALUES ('bot-run:builder', '["crew.delegate","worktree"]'),
        ('bosun-run:restricted', '[]'), ('bot-run:malformed', 'invalid')`;
      assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make("ordinary")), undefined);
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:builder")),
        new Set(["crew", "worktree"]),
      );
      for (const id of ["bosun-run:restricted", "bot-run:malformed", "bot-run:missing"]) {
        assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make(id)), new Set());
      }
    }),
  );
});
