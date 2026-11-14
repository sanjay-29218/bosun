import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import {
  CREW_MEMBER_GRANT,
  crewMcpCapabilities as capabilitiesWith,
  crewThreadGrants,
} from "./crewMcpCapabilities.ts";

const DEFAULTS: ReadonlySet<McpCapability> = new Set([
  "orchestration",
  "worktree",
  "pull-requests",
  "preview",
]);
const crewMcpCapabilities = (threadId: ThreadId) => capabilitiesWith(threadId, DEFAULTS);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("bot MCP grants", (it) => {
  it.effect("gives crew threads the ordinary defaults they weren't denied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE crew_runs (id TEXT, member_id TEXT, thread_id TEXT, withheld_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE bots (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`CREATE TABLE crew_members (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`INSERT INTO crew_runs VALUES
        ('builder', 'role', 'bot-run:builder', '[]'),
        ('no-browser', 'role', 'bot-run:no-browser', '["preview"]'),
        ('nothing', 'role', 'bot-run:nothing',
          '["orchestration","worktree","pull-requests","preview","device"]'),
        ('bare', 'role', 'bosun-run:bare', '[]'),
        ('malformed', 'role', 'bot-run:malformed', 'invalid'),
        ('bot-hq:bot-ops', 'bot-ops', 'bot-run:bot-hq:bot-ops', '["worktree"]'),
        ('captain-request', 'bot-ops', 'bot-run:captain-request', '["preview","orchestration"]')`;
      yield* sql`INSERT INTO bots VALUES ('bot-ops', '["preview"]')`;
      assert.deepStrictEqual(yield* crewMcpCapabilities(ThreadId.make("ordinary")), DEFAULTS);
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:builder")),
        new Set([...DEFAULTS, "crew"]),
      );
      // Withholding a toolkit removes it, and never adds one the environment turned off (devices).
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:no-browser")),
        new Set(["orchestration", "worktree", "pull-requests", "crew"]),
      );
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:nothing")),
        new Set(["crew"]),
      );
      // A bot's headquarters follows the bot's withheld tools, not the ones saved on its run.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:bot-hq:bot-ops")),
        new Set(["orchestration", "worktree", "pull-requests", "crew"]),
      );
      // The bot's other runs keep the tools saved when they started.
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:captain-request")),
        new Set(["worktree", "pull-requests", "crew"]),
      );
      // Granting the toolkit back restores it on the next call.
      yield* sql`UPDATE bots SET withheld_tools_json = '[]' WHERE id = 'bot-ops'`;
      assert.deepStrictEqual(
        yield* crewMcpCapabilities(ThreadId.make("bot-run:bot-hq:bot-ops")),
        new Set([...DEFAULTS, "crew"]),
      );
      // Every crew thread gets the crew tools, granted or not; each tool checks its own grant.
      for (const id of ["bosun-run:bare", "bot-run:malformed", "bot-run:missing"]) {
        assert.deepStrictEqual(
          yield* crewMcpCapabilities(ThreadId.make(id)),
          new Set([...DEFAULTS, "crew"]),
        );
      }
    }),
  );

  it.effect("grants what isn't withheld, and bot-only tools only to bots", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS crew_runs
          (id TEXT, member_id TEXT, thread_id TEXT, withheld_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE IF NOT EXISTS bots (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS crew_members (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`INSERT INTO bots VALUES ('scout', '[]'), ('quiet', '["crew.workflows"]')`;
      yield* sql`INSERT INTO crew_members VALUES ('project-manager:web', '[]')`;
      yield* sql`INSERT INTO crew_runs VALUES
        ('bot-hq:scout', 'scout', 'bot-run:bot-hq:scout', '[]'),
        ('bot-hq:quiet', 'quiet', 'bot-run:bot-hq:quiet', '[]'),
        ('scout-request', 'scout', 'bot-run:scout-request', '[]'),
        ('scout-broken', 'scout', 'bot-run:scout-broken', 'invalid'),
        ('saved-before-devices', 'builder:web', 'bot-run:saved-before-devices',
          '["orchestration","worktree","pull-requests","preview"]'),
        ('member-run', 'builder:web', 'bot-run:member-run', '[]'),
        ('project-hq:web', 'project-manager:web', 'bot-run:project-hq:web', '[]')`;
      const grants = (id: string) => crewThreadGrants(ThreadId.make(id));
      // A list saved before a toolkit existed doesn't name it, so the new toolkit is granted.
      assert.deepStrictEqual(yield* grants("bot-run:saved-before-devices"), ["device"]);
      assert.deepStrictEqual(yield* grants("bot-run:bot-hq:scout"), [
        "crew.workflows",
        "orchestration",
        "worktree",
        "pull-requests",
        "preview",
        "device",
      ]);
      assert.isTrue((yield* grants("bot-run:scout-request"))!.includes("crew.workflows"));
      assert.isFalse((yield* grants("bot-run:bot-hq:quiet"))!.includes("crew.workflows"));
      assert.isFalse((yield* grants("bot-run:scout-broken"))!.includes("crew.workflows"));
      for (const id of ["bot-run:member-run", "bot-run:project-hq:web"]) {
        assert.deepStrictEqual(yield* grants(id), [
          "orchestration",
          "worktree",
          "pull-requests",
          "preview",
          "device",
        ]);
      }
    }),
  );

  it.effect("holds a crew thread's subagents to its tools, without the crew tools", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS crew_runs
          (id TEXT, member_id TEXT, thread_id TEXT, withheld_tools_json TEXT)
      `;
      yield* sql`CREATE TABLE IF NOT EXISTS bots (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS crew_members (id TEXT, withheld_tools_json TEXT)`;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)
      `;
      yield* sql`INSERT INTO crew_runs VALUES
        ('stage', 'role', 'bot-run:stage', '["pull-requests","preview","device"]')`;
      const lineage = (parent: string, relationship: string, member?: string) =>
        JSON.stringify({
          lineage: { parentThreadId: parent, relationshipToParent: relationship },
          ...(member === undefined ? {} : { feature: { id: "feature", title: "F", member } }),
        });
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES
        ('helper', ${lineage("bot-run:stage", "subagent")}),
        ('helper-of-helper', ${lineage("helper", "subagent")}),
        ('fork', ${lineage("bot-run:stage", "fork")}),
        ('plain-helper', ${lineage("ordinary", "subagent")}),
        ('designer', ${lineage("bot-run:stage", "subagent", "Designer")}),
        ('designer-helper', ${lineage("designer", "subagent", "Designer")})`;

      // Only a crew member its lead delegated to asks the person, not that member's helpers.
      assert.include(yield* crewThreadGrants(ThreadId.make("designer")), CREW_MEMBER_GRANT);
      for (const id of ["helper", "designer-helper"]) {
        assert.notInclude(yield* crewThreadGrants(ThreadId.make(id)), CREW_MEMBER_GRANT);
      }

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
