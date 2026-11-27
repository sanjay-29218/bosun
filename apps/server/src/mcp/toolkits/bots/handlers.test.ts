import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BotReach from "../../../bots/BotReach.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as BotTransfer from "../../../bots/BotTransfer.ts";
import { LibraryImports } from "../../../crew/LibraryImports.ts";
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
            Layer.mock(BotReach.BotReach)({}),
            Layer.mock(BotTransfer.BotTransfer)({}),
            Layer.mock(LibraryImports)({}),
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

it.effect("every thread, a crew one included, changes bots with full access", () =>
  Effect.gen(function* () {
    const control = new Set(["orchestration" as const]);
    for (const thread of ["bot-run:builder", "bot-run:bot-hq:bot", "thread:person"]) {
      const threadId = ThreadId.make(thread);
      expect(yield* reorder(threadId, control, "full-access")).toEqual([["bot-a"]]);
      expect(yield* reorder(threadId, control, "approval-required")).toBe("capability_denied");
    }
  }),
);
