import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { crewMcpCapabilities, isFeatureCrewMember } from "./crewMcpCapabilities.ts";

const DEFAULTS: ReadonlySet<McpCapability> = new Set([
  "orchestration",
  "worktree",
  "pull-requests",
  "preview",
]);

it("gives every crew thread the ordinary defaults and the crew tools, and others the defaults", () => {
  for (const id of ["bot-run:builder", "bot-run:bot-hq:bot-ops", "bosun-run:bare"]) {
    assert.deepStrictEqual(
      crewMcpCapabilities(ThreadId.make(id), DEFAULTS),
      new Set([...DEFAULTS, "crew"]),
    );
  }
  // A thread the environment gives no device tools doesn't get them as a crew thread either.
  assert.isFalse(crewMcpCapabilities(ThreadId.make("bot-run:builder"), DEFAULTS).has("device"));
  for (const id of ["ordinary", "helper"]) {
    assert.deepStrictEqual(crewMcpCapabilities(ThreadId.make(id), DEFAULTS), DEFAULTS);
  }
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("feature crew members", (it) => {
  it.effect("is a subagent its lead delegated to by name, not that member's helpers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)
      `;
      const lineage = (parent: string, relationship: string, member?: string) =>
        JSON.stringify({
          lineage: { parentThreadId: parent, relationshipToParent: relationship },
          ...(member === undefined ? {} : { feature: { id: "feature", title: "F", member } }),
        });
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES
        ('designer', ${lineage("bot-run:stage", "subagent", "Designer")}),
        ('designer-helper', ${lineage("designer", "subagent", "Designer")}),
        ('helper', ${lineage("bot-run:stage", "subagent")}),
        ('fork', ${lineage("bot-run:stage", "fork", "Designer")})`;

      assert.isTrue(yield* isFeatureCrewMember(ThreadId.make("designer")));
      for (const id of ["designer-helper", "helper", "fork", "bot-run:stage", "missing"]) {
        assert.isFalse(yield* isFeatureCrewMember(ThreadId.make(id)), id);
      }
    }),
  );
});
