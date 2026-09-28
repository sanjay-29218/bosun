import {
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  BotStore,
  type BotDefinition,
  type BotRole,
  type BotRun,
  type BotRunSummary,
} from "./BotStore.ts";
import { BotThreadRuntime } from "./BotThreadRuntime.ts";

export class BotValidationError extends Error {
  readonly _tag = "BotValidationError";
}

export interface CreateBotDefinitionInput {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly role: BotRole;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface CreateBotRunInput {
  readonly id: string;
  readonly botId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
}

export interface BotRunView {
  readonly run: BotRun;
  readonly turnState: "missing" | "pending" | "running" | "completed" | "interrupted" | "error";
  readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
}

export interface BotServiceShape {
  readonly createDefinition: (
    input: CreateBotDefinitionInput,
  ) => Effect.Effect<BotDefinition, BotServiceError>;
  readonly getDefinition: (id: string) => Effect.Effect<BotDefinition | null, PersistenceSqlError>;
  readonly createRun: (input: CreateBotRunInput) => Effect.Effect<BotRun, BotServiceError>;
  readonly getRun: (
    id: string,
  ) => Effect.Effect<BotRunView | null, PersistenceSqlError | ProjectionRepositoryError>;
  readonly listRunSummaries: (
    projectId: ProjectId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<BotRunSummary>, PersistenceSqlError>;
  readonly reconcileRuns: () => Effect.Effect<void, PersistenceSqlError>;
}

export type BotServiceError =
  | BotValidationError
  | PersistenceSqlError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export class BotService extends Context.Service<BotService, BotServiceShape>()(
  "t3/bots/BotService",
) {}

const nonEmpty = (value: string, field: string, limit: number) => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) {
    throw new BotValidationError(`${field} must contain 1-${limit} characters`);
  }
  return trimmed;
};

const sameRunRequest = (run: BotRun, input: CreateBotRunInput) =>
  run.botId === input.botId && run.projectId === input.projectId && run.taskText === input.taskText;

export const BotServiceLive = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const store = yield* BotStore;
    const runtime = yield* BotThreadRuntime;

    const threadInput = (run: BotRun) => ({
      runId: run.id,
      threadId: run.threadId,
      projectId: run.projectId,
      title: run.title,
      prompt: `${run.instructions}\n\nTask:\n${run.taskText}`,
      modelSelection: run.modelSelection,
      runtimeMode: run.runtimeMode,
      createdAt: run.createdAt,
    });

    const markDispatched = (run: BotRun, effect: Effect.Effect<void, OrchestrationDispatchError>) =>
      effect.pipe(
        Effect.flatMap(() =>
          DateTime.now.pipe(
            Effect.flatMap((now) => store.markStarted(run.id, DateTime.formatIso(now))),
          ),
        ),
        Effect.tapError(() =>
          store.markDispatchError(run.id, "Thread dispatch failed; retry pending"),
        ),
      );

    const dispatch = (run: BotRun) => markDispatched(run, runtime.start(threadInput(run)));
    const replayPending = (run: BotRun) =>
      store
        .nextRecoveryAttempt(run.id)
        .pipe(
          Effect.flatMap((attempt) =>
            markDispatched(run, runtime.replayPending(threadInput(run), attempt)).pipe(
              Effect.result,
              Effect.asVoid,
            ),
          ),
        );

    const createDefinition: BotServiceShape["createDefinition"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Bot ID", 128),
          catch: () => new BotValidationError("Invalid bot ID"),
        });
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Bot name", 200),
          catch: () => new BotValidationError("Invalid bot name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Bot instructions", 16_000),
          catch: () => new BotValidationError("Invalid bot instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => {
            const tools = input.allowedTools ?? [];
            if (tools.length > 32) throw new BotValidationError("Too many tools");
            return [...new Set(tools.map((tool) => nonEmpty(tool, "Tool", 100)))];
          },
          catch: () => new BotValidationError("Invalid tool grants"),
        });
        if ((input.role === "captain") !== (input.projectId === null)) {
          return yield* Effect.fail(
            new BotValidationError("Captain is environment-wide; other roles need a project"),
          );
        }
        if (input.projectId !== null && !(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new BotValidationError("Project does not exist"));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const definition: BotDefinition = {
          ...input,
          id,
          name,
          instructions,
          allowedTools,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertDefinition(definition);
        return definition;
      });

    const createRun: BotServiceShape["createRun"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Run ID", 128),
          catch: () => new BotValidationError("Invalid run ID"),
        });
        const taskText = yield* Effect.try({
          try: () => nonEmpty(input.taskText, "Task", 16_000),
          catch: () => new BotValidationError("Invalid task"),
        });
        const request = { ...input, id, taskText };
        const existing = yield* store.getRun(id);
        if (existing !== null) {
          if (!sameRunRequest(existing, request)) {
            return yield* Effect.fail(new BotValidationError("Run ID belongs to another request"));
          }
          if (existing.dispatchState === "queued") yield* dispatch(existing);
          return (yield* store.getRun(id))!;
        }
        const bot = yield* store.getDefinition(input.botId);
        if (bot === null || !bot.enabled) {
          return yield* Effect.fail(new BotValidationError("Bot is unavailable"));
        }
        if (bot.projectId !== null && bot.projectId !== input.projectId) {
          return yield* Effect.fail(new BotValidationError("Bot belongs to another project"));
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new BotValidationError("Project does not exist"));
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const run: BotRun = {
          id,
          botId: bot.id,
          projectId: input.projectId,
          threadId: ThreadId.make(`bosun-run:${id}`),
          taskText,
          title: `${bot.name}: ${taskText.slice(0, 80)}`,
          instructions: bot.instructions,
          allowedTools: bot.allowedTools,
          botRevision: bot.revision,
          modelSelection: bot.modelSelection,
          runtimeMode: bot.runtimeMode,
          dispatchState: "queued",
          recoveryAttempt: 0,
          lastError: null,
          createdAt,
          dispatchedAt: null,
        };
        yield* store.insertRun(run);
        const persisted = yield* store.getRun(id);
        if (persisted === null || !sameRunRequest(persisted, request)) {
          return yield* Effect.fail(new BotValidationError("Run ID belongs to another request"));
        }
        if (persisted.dispatchState === "queued") yield* dispatch(persisted);
        return (yield* store.getRun(id))!;
      });

    return {
      createDefinition,
      getDefinition: store.getDefinition,
      createRun,
      getRun: (id) =>
        store.getRun(id).pipe(
          Effect.flatMap((run) =>
            run === null
              ? Effect.succeed(null)
              : runtime.getTurnState(run.threadId).pipe(
                  Effect.map((turnState) => ({
                    run,
                    turnState,
                    status:
                      run.dispatchState === "queued"
                        ? ("queued" as const)
                        : turnState === "completed"
                          ? ("completed" as const)
                          : turnState === "error" || turnState === "missing"
                            ? ("failed" as const)
                            : turnState === "interrupted"
                              ? ("interrupted" as const)
                              : ("running" as const),
                  })),
                ),
          ),
        ),
      listRunSummaries: (projectId, limit = 50) =>
        store.listRunSummaries(projectId, Math.max(1, Math.min(100, Math.floor(limit)))),
      reconcileRuns: () =>
        Effect.gen(function* () {
          // Recover accepted turns from a prior process before dispatching new queued runs.
          // Otherwise a newly dispatched turn could look stale before its reactor worker starts.
          let afterId = "";
          while (true) {
            const ids = yield* runtime.listPendingStartedRunIds(afterId, 100);
            if (ids.length === 0) break;
            yield* Effect.forEach(
              ids,
              (id) =>
                store
                  .getRun(id)
                  .pipe(Effect.flatMap((run) => (run === null ? Effect.void : replayPending(run)))),
              { concurrency: 1, discard: true },
            );
            afterId = ids[ids.length - 1]!;
          }
          const queued = yield* store.listQueuedRuns();
          yield* Effect.forEach(queued, (run) => dispatch(run).pipe(Effect.result), {
            concurrency: 1,
            discard: true,
          });
        }),
    } satisfies BotServiceShape;
  }),
);
