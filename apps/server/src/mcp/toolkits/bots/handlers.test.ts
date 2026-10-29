import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

/** Reorders bots as `threadId`; returns the failure code, or the order BotService was given. */
const reorder = (
  threadId: ThreadId,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  runtimeMode: "approval-required" | "full-access",
) => {
  const reordered: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const toolkit = yield* BotsToolkit;
    const results = yield* toolkit
      .handle("t3_bot_reorder", { botIds: ["bot-a"] })
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = results.at(-1)!;
    return last.isFailure ? (last.result as { readonly code: string }).code : reordered;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(BotsHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:bots"),
              requestNamespace: "provider:bots",
              thread: {
                threadId,
                providerSessionId: "provider:bots",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities,
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { runtimeMode })),
            }),
            Layer.mock(BotService.BotService)({
              reorder: (botIds) => {
                reordered.push(botIds);
                return Effect.succeed([]);
              },
            }),
          ),
        ),
      ),
    ),
  );
};

it.effect("bots change bots with Manage workflows; other threads need full access", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE crew_runs (id TEXT, member_id TEXT, thread_id TEXT, allowed_tools_json TEXT)
    `;
    yield* sql`CREATE TABLE bots (id TEXT, allowed_tools_json TEXT)`;
    yield* sql`INSERT INTO crew_runs VALUES
      ('builder', 'role', 'bot-run:builder', '["orchestration"]'),
      ('manager', 'bot', 'bot-run:manager', '["crew.workflows"]')`;
    const control = new Set(["orchestration" as const]);

    // Threads and subagents alone no longer reaches the bot tools, even with full access.
    expect(yield* reorder(ThreadId.make("bot-run:builder"), control, "full-access")).toBe(
      "capability_denied",
    );
    expect(
      yield* reorder(ThreadId.make("bot-run:manager"), new Set(["crew"]), "approval-required"),
    ).toEqual([["bot-a"]]);

    expect(yield* reorder(ThreadId.make("thread:person"), control, "approval-required")).toBe(
      "capability_denied",
    );
    expect(yield* reorder(ThreadId.make("thread:person"), control, "full-access")).toEqual([
      ["bot-a"],
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
