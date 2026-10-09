import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkflowStageHandoff,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotHandoffService } from "../../../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { BotStore, type BotRun } from "../../../bots/BotStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:bots");
const stageThread = ThreadId.make("bot-run:stage");
const record: WorkflowStageHandoff = {
  id: "workflow:stage",
  featureId: "feature",
  stepId: "build",
  executionId: "execution",
  attempt: 1,
  workflow: { id: "delivery", name: "Delivery", revision: 2 },
  from: { stepId: "design", outcome: "ready" },
  brief: "Build the board",
  task: "Build",
  scope: null,
  outcomes: ["built"],
  produces: [],
  outputs: [],
  notes: [],
  retry: null,
  workspace: { cwd: "/repo", branch: null, commit: null },
  createdAt: "2026-10-09T00:00:00Z",
};

const handleAs = (threadId: ThreadId, allowedTools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const toolkit = yield* BotsToolkit;
    return yield* toolkit.handle("bots_stage_handoff", {}).pipe(Stream.unwrap, Stream.runCollect);
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
              capabilities: new Set(["bots" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
            Layer.mock(BotHandoffService)({}),
            Layer.mock(BotHandoffStore)({
              getRunByThread: (id) => Effect.succeed(id === stageThread ? "run:stage" : null),
            }),
            Layer.mock(BotStore)({
              getRun: () =>
                Effect.succeed({ id: "run:stage", projectId, allowedTools } as unknown as BotRun),
            }),
            Layer.mock(WorkflowService)({
              getStageHandoffForThread: (project, thread) =>
                Effect.succeed(project === projectId && thread === stageThread ? record : null),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("lets a stage bot read the handoff its stage started from", () =>
  Effect.gen(function* () {
    const read = yield* handleAs(stageThread, ["bots.respond"]);
    expect(read.at(-1)?.result).toEqual(record);

    const ungranted = yield* Effect.flip(handleAs(stageThread, ["bots.delegate"]));
    expect(ungranted).toMatchObject({ _tag: "BotToolFailedError" });
    expect(ungranted.message).toContain("Caller is not a workflow stage bot");

    const plainThread = yield* Effect.flip(handleAs(ThreadId.make("thread:plain"), []));
    expect(plainThread.message).toContain("Caller is not a workflow stage bot");
  }),
);
