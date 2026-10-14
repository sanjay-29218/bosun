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

import { BotProjects } from "../../../bots/BotProjects.ts";
import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore, type CrewRun } from "../../../crew/CrewStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CrewHandlers from "./handlers.ts";
import { CrewToolkit } from "./tools.ts";

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
    const toolkit = yield* CrewToolkit;
    return yield* toolkit.handle("crew_stage_handoff", {}).pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(CrewHandlers.layer).pipe(
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
              capabilities: new Set(["crew" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
            Layer.mock(CrewHandoffService)({}),
            Layer.mock(BotProjects)({}),
            Layer.mock(CrewHandoffStore)({
              getRunByThread: (id) => Effect.succeed(id === stageThread ? "run:stage" : null),
            }),
            Layer.mock(CrewStore)({
              getRun: () =>
                Effect.succeed({ id: "run:stage", projectId, allowedTools } as unknown as CrewRun),
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

it.effect("lets a stage member read the handoff its stage started from", () =>
  Effect.gen(function* () {
    const read = yield* handleAs(stageThread, ["crew.respond"]);
    expect(read.at(-1)?.result).toEqual(record);

    const ungranted = yield* Effect.flip(handleAs(stageThread, ["crew.delegate"]));
    expect(ungranted).toMatchObject({ _tag: "CrewToolFailedError" });
    expect(ungranted.message).toContain("Caller is not a workflow stage member");

    const plainThread = yield* Effect.flip(handleAs(ThreadId.make("thread:plain"), []));
    expect(plainThread.message).toContain("Caller is not a workflow stage member");
  }),
);
