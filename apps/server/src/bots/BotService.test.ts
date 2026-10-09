// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { BotTestOrchestration, seedBotProject } from "./BotRuntime.testkit.ts";
import { OrchestratorDispatchError as OrchestrationCommandInvariantError } from "../orchestration-v2/Orchestrator.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { BotService, BotServiceLive } from "./BotService.ts";
import { BotStore, BotStoreLive } from "./BotStore.ts";
import { BotThreadRuntime } from "./BotThreadRuntime.ts";
import { BotRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bot-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const withSystem = <A, E>(
  databasePath: string,
  use: (services: {
    readonly bots: BotService["Service"];
    readonly store: BotStore["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly query: {
      readonly getThreadDetailById: (threadId: ThreadId) => Effect.Effect<
        Option.Option<{
          readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
        }>,
        import("../orchestration-v2/Orchestrator.ts").OrchestratorV2Error
      >;
    };
  }) => Effect.Effect<A, E, ProjectStore.ProjectStoreV2>,
) => {
  const orchestration = BotTestOrchestration;
  const layer = Layer.mergeAll(
    orchestration,
    BotRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-test-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* use({
      bots: yield* BotService,
      store: yield* BotStore,
      engine,
      sql: yield* SqlClient.SqlClient,
      query: {
        getThreadDetailById: (threadId) =>
          engine.getThreadRecords(threadId, ["messages"]).pipe(Effect.map(Option.some)),
      },
    });
  }).pipe(Effect.provide(layer));
};

const createProject = (_engine: OrchestrationEngineService["Service"]) =>
  seedBotProject({
    projectId,
    title: "Bot test project",
    workspaceRoot: "/tmp/bot-test-project",
  });

const createBot = (bots: BotService["Service"]) =>
  bots.createDefinition({
    id: "execution-1",
    projectId,
    name: "Builder",
    instructions: "Implement the assigned change.",
    allowedTools: ["bots.delegate"],
    modelSelection,
    runtimeMode: "approval-required",
  });

describe("Bot foundation", () => {
  effectIt.effect("keeps custom templates, bot instances, and hierarchy distinct", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-custom-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, engine }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          const crews = yield* Effect.all(
            [
              bots.ensureCrew(projectId, modelSelection),
              bots.ensureCrew(projectId, modelSelection),
            ],
            { concurrency: 2 },
          );
          expect(crews[0].map((bot) => bot.id)).toEqual(crews[1].map((bot) => bot.id));
          const template = yield* bots.createTemplate({
            id: "template:custom",
            projectId,
            name: "Researcher",
            instructions: "Research the assigned question.",
            modelSelection,
            runtimeMode: "approval-required",
            autoCreateForFeature: true,
          });
          const bot = yield* bots.instantiate("bot:researcher", projectId, template.id);
          expect(bot.templateId).toBe(template.id);
          expect(bot.templateRevision).toBe(1);
          expect((yield* bots.getTemplate(template.id))?.autoCreateForFeature).toBe(true);
          const updatedTemplate = yield* bots.updateTemplate({
            ...template,
            name: "Investigator",
            instructions: "Investigate a question.",
            expectedRevision: template.revision,
            enabled: false,
          });
          expect(updatedTemplate.revision).toBe(2);
          expect((yield* bots.getDefinition(bot.id))?.name).toBe("Researcher");
          expect(
            (yield* bots.instantiate("bot:second", projectId, template.id).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          yield* bots.setHierarchyParent(bot.id, `bot-manager:${projectId}`, 2);
          const hierarchy = yield* bots.listHierarchyForProject(projectId);
          expect(hierarchy.find((node) => node.botId === bot.id)).toMatchObject({
            parentBotId: `bot-manager:${projectId}`,
            position: 2,
          });
          expect(
            hierarchy.find((node) => node.botId === `bot-manager:${projectId}`)?.parentBotId,
          ).toBe("bot-captain");
          expect(
            (yield* bots.setHierarchyParent(`bot-manager:${projectId}`, bot.id).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* bots
              .createDefinition({
                id: "bot:wrong-scope",
                projectId: null,
                templateId: template.id,
                name: "Wrong scope",
                instructions: "Invalid.",
                modelSelection,
                runtimeMode: "approval-required",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("retains a failed dispatch and retries it without a new run", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fakeRuntime = Layer.succeed(BotThreadRuntime, {
        projectExists: () => Effect.succeed(true),
        start: () =>
          Effect.sync(() => ++attempts).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.create",
                      commandId: CommandId.make("test-failure"),
                      cause: new Error("test failure"),
                    }),
                  )
                : Effect.void,
            ),
          ),
        getTurnState: () => Effect.succeed("pending" as const),
        replayPending: () => Effect.void,
        notify: () => Effect.void,
        interrupt: () => Effect.void,
        listPendingStartedRunIds: () => Effect.succeed([]),
      });
      const layer = BotServiceLive.pipe(
        Layer.provideMerge(BotStoreLive),
        Layer.provide(fakeRuntime),
        Layer.provide(SqlitePersistence.layerMemory),
      );
      yield* Effect.gen(function* () {
        const bots = yield* BotService;
        const bot = yield* bots.createDefinition({
          id: "retry-bot",
          projectId,
          name: "Retry bot",
          instructions: "Try this task.",
          modelSelection,
          runtimeMode: "approval-required",
        });
        const first = yield* bots
          .createRun({
            id: "retry-run",
            botId: bot.id,
            projectId,
            taskText: "Retry after failure",
          })
          .pipe(Effect.result);
        expect(first._tag).toBe("Failure");
        const queued = yield* bots.getRun("retry-run");
        expect(queued?.run.dispatchState).toBe("queued");
        expect(queued?.run.lastError).toContain("retry pending");
        yield* bots.reconcileRuns();
        const resumed = yield* bots.getRun("retry-run");
        expect(resumed?.run.dispatchState).toBe("started");
        expect(resumed?.run.lastError).toBeNull();
        expect(attempts).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  effectIt.effect("links a bot run to one T3 thread and replays without a second turn", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-run-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* withSystem(databasePath, ({ bots, engine, query, sql }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* createBot(bots);
          const request = {
            id: "run-1",
            botId: "execution-1",
            projectId,
            taskText: "Add the small change",
          };
          const first = yield* bots.createRun(request);
          const replay = yield* bots.createRun(request);
          const detail = yield* query.getThreadDetailById(first.threadId);
          expect(first.dispatchState).toBe("started");
          expect(first.allowedTools).toEqual(["bots.delegate"]);
          expect(first.botRevision).toBe(1);
          expect(replay.threadId).toBe(first.threadId);
          const conflicting = yield* bots
            .createRun({ ...request, taskText: "Another task" })
            .pipe(Effect.flip);
          expect(conflicting.message).toContain("Run ID belongs to another request");
          expect(detail._tag).toBe("Some");
          if (detail._tag === "Some") {
            expect(detail.value.messages.filter((message) => message.role === "user")).toHaveLength(
              1,
            );
            expect(detail.value.messages[0]?.text).toContain("Implement the assigned change.");
          }
          const view = yield* bots.getRun("run-1");
          expect(view?.run.threadId).toBe(ThreadId.make("bot-run:run-1"));
          const summaries = yield* bots.listRunSummaries(projectId, 1);
          expect(summaries).toHaveLength(1);
          expect(summaries[0]).not.toHaveProperty("taskText");
          expect(summaries[0]).not.toHaveProperty("instructions");
          yield* sql`UPDATE bot_runs SET thread_id = 'bot-run:legacy' WHERE id = 'run-1'`;
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
            VALUES ('bot-run:legacy', 'old-turn', 'completed', '2026-01-01', '[]')`;
          yield* bots.reconcileRuns();
          expect((yield* bots.getRun("run-1"))?.turnState).toBe("completed");
          expect((yield* bots.listRunSummaries(projectId, 1))[0]?.turnState).toBe("completed");
          expect((yield* bots.getRun("run-1"))?.run.recoveryAttempt).toBe(0);
          expect(yield* engine.getThreadShell(ThreadId.make("bot-run:legacy"))).toBeNull();
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("recovers a persisted queued run after restart", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-restart-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        yield* withSystem(databasePath, ({ bots, store, engine }) =>
          Effect.gen(function* () {
            yield* createProject(engine);
            const bot = yield* createBot(bots);
            yield* store.insertRun({
              id: "queued-1",
              botId: bot.id,
              projectId,
              threadId: ThreadId.make("bot-run:queued-1"),
              taskText: "Recover this task",
              title: "Builder: Recover this task",
              instructions: bot.instructions,
              allowedTools: bot.allowedTools,
              botRevision: bot.revision,
              modelSelection: bot.modelSelection,
              runtimeMode: bot.runtimeMode,
              dispatchState: "queued",
              recoveryAttempt: 0,
              lastError: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              dispatchedAt: null,
            });
            // Simulate a crash after T3 accepted thread creation but before turn start.
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("bot-run:queued-1:create"),
              threadId: ThreadId.make("bot-run:queued-1"),
              projectId,
              title: "Builder: Recover this task",
              modelSelection: bot.modelSelection,
              runtimeMode: bot.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "agent",
              creationSource: "mcp",
            });
          }),
        );
        yield* withSystem(databasePath, ({ bots, query }) =>
          Effect.gen(function* () {
            yield* bots.reconcileRuns();
            const recovered = yield* bots.getRun("queued-1");
            const detail = yield* query.getThreadDetailById(ThreadId.make("bot-run:queued-1"));
            expect(recovered?.run.dispatchState).toBe("started");
            expect(detail._tag).toBe("Some");
            if (detail._tag === "Some") {
              expect(
                detail.value.messages.filter((message) => message.role === "user"),
              ).toHaveLength(1);
            }
          }),
        );
        yield* withSystem(databasePath, ({ bots, query }) =>
          Effect.gen(function* () {
            yield* bots.reconcileRuns();
            const replayed = yield* bots.getRun("queued-1");
            const detail = yield* query.getThreadDetailById(ThreadId.make("bot-run:queued-1"));
            expect(replayed?.run.recoveryAttempt).toBe(0);
            expect(detail._tag).toBe("Some");
            if (detail._tag === "Some") {
              expect(
                detail.value.messages.filter((message) => message.role === "user"),
              ).toHaveLength(1);
            }
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
