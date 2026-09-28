import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  toPersistenceSqlError,
  type ProjectionRepositoryError,
  type PersistenceSqlError,
} from "../persistence/Errors.ts";

export interface BotThreadStart {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}

export interface BotThreadRuntimeShape {
  readonly projectExists: (
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly start: (input: BotThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly replayPending: (
    input: BotThreadStart,
    recoveryAttempt: number,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly listPendingStartedRunIds: (
    afterId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  readonly getTurnState: (
    threadId: ThreadId,
  ) => Effect.Effect<
    "missing" | "pending" | "running" | "completed" | "interrupted" | "error",
    ProjectionRepositoryError
  >;
}

export class BotThreadRuntime extends Context.Service<BotThreadRuntime, BotThreadRuntimeShape>()(
  "t3/bots/BotThreadRuntime",
) {}

export const BotThreadRuntimeV1 = Layer.effect(
  BotThreadRuntime,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;

    const submitTurn = (input: BotThreadStart, commandId: string) =>
      engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(`bosun-run:${input.runId}:message`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          createdAt: input.createdAt,
        })
        .pipe(Effect.asVoid);

    return {
      projectExists: (projectId) =>
        query.getProjectShellById(projectId).pipe(Effect.map(Option.isSome)),
      start: (input) =>
        Effect.gen(function* () {
          // Command receipts make these fixed IDs safe to replay after either dispatch.
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`bosun-run:${input.runId}:create`),
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: input.createdAt,
          });
          yield* submitTurn(input, `bosun-run:${input.runId}:start`);
        }),
      replayPending: (input, recoveryAttempt) =>
        submitTurn(input, `bosun-run:${input.runId}:replay:${recoveryAttempt}`),
      listPendingStartedRunIds: (afterId, limit) =>
        sql<{ readonly id: string }>`
          SELECT r.id FROM bosun_bot_runs AS r
          JOIN projection_turns AS t ON t.thread_id = r.thread_id AND t.state = 'pending'
          LEFT JOIN projection_thread_sessions AS s ON s.thread_id = r.thread_id
          WHERE r.dispatch_state = 'started' AND s.thread_id IS NULL AND r.id > ${afterId}
          ORDER BY r.id LIMIT ${limit}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("BotThreadRuntime.listPendingStartedRunIds")),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
      getTurnState: (threadId) =>
        query.getThreadShellById(threadId).pipe(
          Effect.map((thread) => {
            if (Option.isNone(thread)) return "missing";
            const state = thread.value.latestTurn?.state;
            return state ?? "pending";
          }),
        ),
    } satisfies BotThreadRuntimeShape;
  }),
);
