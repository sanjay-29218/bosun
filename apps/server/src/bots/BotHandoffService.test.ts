// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { BotTestOrchestration, seedBotProject } from "./BotRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { BotService } from "./BotService.ts";
import { BotHandoffService } from "./BotHandoffService.ts";
import { BotHandoffStore } from "./BotHandoffStore.ts";
import { BotRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bot-handoff-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" };

const withSystem = <A, E>(
  path: string,
  use: (services: {
    readonly bots: BotService["Service"];
    readonly handoffs: BotHandoffService["Service"];
    readonly store: BotHandoffStore["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<A, E, SqlClient.SqlClient | ProjectStore.ProjectStoreV2>,
) => {
  const orchestration = BotTestOrchestration;
  const layer = Layer.mergeAll(
    orchestration,
    BotRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(path)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-handoff-test-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    return yield* use({
      bots: yield* BotService,
      handoffs: yield* BotHandoffService,
      store: yield* BotHandoffStore,
      engine: yield* OrchestrationEngineService,
      sql: yield* SqlClient.SqlClient,
    });
  }).pipe(Effect.provide(layer));
};

describe("Bot handoffs", () => {
  effectIt.effect("routes questions and answers while rejecting unauthorized delegation", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-question-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, handoffs, store }) =>
        Effect.gen(function* () {
          yield* seedBotProject({
            projectId,
            title: "Handoff questions",
            workspaceRoot: directory,
          });
          yield* bots.ensureCrew(projectId, modelSelection);
          const captain = yield* bots.createRun({
            id: "captain-question",
            botId: "bot-captain",
            projectId,
            taskText: "Coordinate a question",
          });
          const managerRequest = yield* handoffs.delegate({
            id: "manager-question",
            sourceThreadId: captain.threadId,
            targetBotId: `bot-manager:${projectId}`,
            projectId,
            taskText: "Clarify and execute",
          });
          const manager = (yield* bots.getRun(managerRequest.targetRunId))!.run;
          const executionRequest = yield* handoffs.delegate({
            id: "builder-question",
            sourceThreadId: manager.threadId,
            targetBotId: `bot-builder:${projectId}`,
            projectId,
            taskText: "Implement after clarification",
          });
          const execution = (yield* bots.getRun(executionRequest.targetRunId))!.run;
          expect(
            (yield* handoffs
              .delegate({
                id: "forbidden",
                sourceThreadId: execution.threadId,
                targetBotId: `bot-manager:${projectId}`,
                projectId,
                taskText: "Escalate improperly",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* handoffs
              .delegate({
                id: "builder-question",
                sourceThreadId: manager.threadId,
                targetBotId: `bot-builder:${projectId}`,
                projectId,
                taskText: "Different task",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* handoffs
              .delegate({
                id: "oversized",
                sourceThreadId: manager.threadId,
                targetBotId: `bot-builder:${projectId}`,
                projectId,
                taskText: "x".repeat(8_001),
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const question = yield* handoffs.ask(execution.threadId, "Which file?");
          expect(question.status).toBe("needs-input");
          expect((yield* store.listByProject(projectId, 1)).length).toBe(2);
          expect((yield* handoffs.waitFor(manager.threadId, question.id)).questionText).toBe(
            "Which file?",
          );
          const answered = yield* handoffs.answerFromBot(
            manager.threadId,
            question.id,
            "Use src/main.ts",
          );
          expect(answered.status).toBe("running");
          expect(answered.notificationState).toBe("delivered");
          expect(
            (yield* handoffs.answerFromBot(manager.threadId, question.id, "Use src/main.ts")).id,
          ).toBe(question.id);
          expect(
            (yield* handoffs.respond(execution.threadId, "completed", "Updated src/main.ts"))
              .status,
          ).toBe("completed");
          expect((yield* handoffs.waitFor(manager.threadId, question.id)).responseText).toBe(
            "Updated src/main.ts",
          );
          const cancelled = yield* handoffs.cancel(managerRequest.id);
          expect(cancelled.status).toBe("cancelled");
          yield* bots.revokeDelegation("bot-captain", `bot-manager:${projectId}`);
          expect((yield* handoffs.retry(managerRequest.id).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* bots.allowDelegation("bot-captain", `bot-manager:${projectId}`);
          const retry = yield* handoffs.retry(managerRequest.id);
          expect(retry.status).toBe("running");
          expect(retry.targetRunId).not.toBe(managerRequest.targetRunId);
          expect(retry.attempt).toBe(2);
          expect(
            (yield* handoffs
              .respond(manager.threadId, "completed", "Late result")
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  effectIt.effect("persists Captain to Manager to Builder and structured outcomes", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* withSystem(databasePath, ({ bots, handoffs, engine }) =>
        Effect.gen(function* () {
          yield* seedBotProject({
            projectId,
            title: "Handoff test",
            workspaceRoot: directory,
          });
          yield* bots.createDefinition({
            id: "captain",
            projectId: null,
            name: "Captain",
            instructions: "Coordinate.",
            allowedTools: ["bots.delegate"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.createDefinition({
            id: "manager",
            projectId,
            name: "Manager",
            instructions: "Manage.",
            allowedTools: ["bots.delegate", "bots.respond", "bots.ask"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.createDefinition({
            id: "execution",
            projectId,
            name: "Builder",
            instructions: "Execute.",
            allowedTools: ["bots.respond", "bots.ask"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.allowDelegation("captain", "manager");
          yield* bots.allowDelegation("manager", "execution");
          const captain = yield* bots.createRun({
            id: "captain-run",
            botId: "captain",
            projectId,
            taskText: "Coordinate the change",
          });
          const manager = yield* handoffs.delegate({
            id: "captain-to-manager",
            sourceThreadId: captain.threadId,
            targetBotId: "manager",
            projectId,
            taskText: "Own the change",
          });
          expect(manager.status).toBe("running");
          expect(
            (yield* handoffs.delegate({
              id: "captain-to-manager",
              sourceThreadId: captain.threadId,
              targetBotId: "manager",
              projectId,
              taskText: "Own the change",
            })).targetRunId,
          ).toBe(manager.targetRunId);
          const managerRun = (yield* bots.getRun(manager.targetRunId))!.run;
          const execution = yield* handoffs.delegate({
            id: "manager-to-execution",
            sourceThreadId: managerRun.threadId,
            targetBotId: "execution",
            projectId,
            taskText: "Implement the change",
            contextText: "Keep the patch small.",
          });
          expect(execution.depth).toBe(2);
          const executionRun = (yield* bots.getRun(execution.targetRunId))!.run;
          const reported = yield* handoffs.respond(
            executionRun.threadId,
            "completed",
            "Patch complete",
          );
          expect(reported.responseText).toBe("Patch complete");
          expect(
            (yield* handoffs.respond(executionRun.threadId, "completed", "Patch complete")).id,
          ).toBe(execution.id);
          expect(
            (yield* handoffs.respond(managerRun.threadId, "completed", "Reviewed patch")).status,
          ).toBe("completed");
          yield* bots.revokeDelegation("manager", "execution");
          expect(
            (yield* handoffs
              .delegate({
                id: "revoked-delegation",
                sourceThreadId: managerRun.threadId,
                targetBotId: "execution",
                projectId,
                taskText: "Another change",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      );
      yield* withSystem(databasePath, ({ bots, handoffs, sql }) =>
        Effect.gen(function* () {
          expect((yield* handoffs.get("manager-to-execution"))?.responseText).toBe(
            "Patch complete",
          );
          expect((yield* handoffs.get("captain-to-manager"))?.status).toBe("completed");
          const noticesBefore = yield* sql<{ readonly text: string }>`
            SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
            WHERE message_id = 'bot-handoff:captain-to-manager:notice:1'
          `;
          expect(noticesBefore[0]?.text).toContain("Reviewed patch");
          yield* bots.reconcileRuns();
          const noticesAfter = yield* sql<{ readonly text: string }>`
            SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
            WHERE message_id = 'bot-handoff:captain-to-manager:notice:1'
          `;
          expect(noticesAfter).toEqual(noticesBefore);
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );
});
