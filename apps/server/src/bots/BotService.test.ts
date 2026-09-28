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
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { BotService, BotServiceLive } from "./BotService.ts";
import { BotStore, BotStoreLive } from "./BotStore.ts";
import { BotThreadRuntime } from "./BotThreadRuntime.ts";
import { BotRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bosun-bot-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const withSystem = <A, E>(
  databasePath: string,
  use: (services: {
    readonly bots: BotService["Service"];
    readonly store: BotStore["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly query: ProjectionSnapshotQuery["Service"];
  }) => Effect.Effect<A, E>,
) => {
  const orchestration = OrchestrationLayerLive;
  const layer = Layer.mergeAll(
    orchestration,
    BotRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provide(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bosun-bot-test-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    return yield* use({
      bots: yield* BotService,
      store: yield* BotStore,
      engine: yield* OrchestrationEngineService,
      query: yield* ProjectionSnapshotQuery,
    });
  }).pipe(Effect.provide(layer));
};

const createProject = (engine: OrchestrationEngineService["Service"]) =>
  engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("bosun-bot-test-project-create"),
    projectId,
    title: "Bot test project",
    workspaceRoot: "/tmp/bosun-bot-test-project",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

const createBot = (bots: BotService["Service"]) =>
  bots.createDefinition({
    id: "execution-1",
    projectId,
    role: "execution",
    name: "Execution",
    instructions: "Implement the assigned change.",
    allowedTools: ["bots.delegate"],
    modelSelection,
    runtimeMode: "approval-required",
  });

describe("Bosun bot foundation", () => {
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
                      detail: "test failure",
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
        Layer.provide(SqlitePersistenceMemory),
      );
      yield* Effect.gen(function* () {
        const bots = yield* BotService;
        const bot = yield* bots.createDefinition({
          id: "retry-bot",
          projectId,
          role: "execution",
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
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bosun-bot-run-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* withSystem(databasePath, ({ bots, engine, query }) =>
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
          expect(view?.run.threadId).toBe(ThreadId.make("bosun-run:run-1"));
          const summaries = yield* bots.listRunSummaries(projectId, 1);
          expect(summaries).toHaveLength(1);
          expect(summaries[0]).not.toHaveProperty("taskText");
          expect(summaries[0]).not.toHaveProperty("instructions");
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
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bosun-bot-restart-")),
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
              threadId: ThreadId.make("bosun-run:queued-1"),
              taskText: "Recover this task",
              title: "Execution: Recover this task",
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
              commandId: CommandId.make("bosun-run:queued-1:create"),
              threadId: ThreadId.make("bosun-run:queued-1"),
              projectId,
              title: "Execution: Recover this task",
              modelSelection: bot.modelSelection,
              runtimeMode: bot.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            });
          }),
        );
        yield* withSystem(databasePath, ({ bots, query }) =>
          Effect.gen(function* () {
            yield* bots.reconcileRuns();
            const recovered = yield* bots.getRun("queued-1");
            const detail = yield* query.getThreadDetailById(ThreadId.make("bosun-run:queued-1"));
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
            const detail = yield* query.getThreadDetailById(ThreadId.make("bosun-run:queued-1"));
            expect(replayed?.run.recoveryAttempt).toBe(1);
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
