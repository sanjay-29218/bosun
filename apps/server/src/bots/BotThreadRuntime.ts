import {
  CommandId,
  ComposerContextId,
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
  readonly botId: string;
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
  ) => Effect.Effect<void, OrchestrationDispatchError | PersistenceSqlError>;
  readonly notify: (
    threadId: ThreadId,
    handoffId: string,
    version: number,
    recipientRunId: string,
    runtimeMode: RuntimeMode,
    prompt: string,
    createdAt: string,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly interrupt: (
    threadId: ThreadId,
    handoffId: string,
    createdAt: string,
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

    const submitTurn = (
      input: BotThreadStart,
      commandId: string,
      pending?: {
        readonly messageId: string;
        readonly text: string;
        readonly createdAt: string;
      },
    ) =>
      engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(pending?.messageId ?? `bosun-run:${input.runId}:message`),
            role: "user",
            text: pending?.text ?? input.prompt,
            attachments: [],
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("bosun-origin"),
                  label: input.botId,
                  kind: "bosun-bot",
                  payload: { botId: input.botId, runId: input.runId },
                },
              ],
            },
          },
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          createdAt: pending?.createdAt ?? input.createdAt,
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
        sql<{
          readonly messageId: string;
          readonly text: string;
          readonly createdAt: string;
        }>`
          SELECT m.message_id AS messageId, m.text, t.requested_at AS createdAt
          FROM projection_turns AS t
          JOIN projection_thread_messages AS m ON m.message_id = t.pending_message_id
          WHERE t.thread_id = ${input.threadId} AND t.state = 'pending'
          ORDER BY t.row_id DESC LIMIT 1
        `.pipe(
          Effect.mapError(toPersistenceSqlError("BotThreadRuntime.replayPending")),
          Effect.flatMap((rows) =>
            rows[0]
              ? submitTurn(input, `bosun-run:${input.runId}:replay:${recoveryAttempt}`, rows[0])
              : Effect.void,
          ),
        ),
      notify: (threadId, handoffId, version, recipientRunId, runtimeMode, prompt, createdAt) =>
        engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`bosun-handoff:${handoffId}:notice:${version}`),
            threadId,
            message: {
              messageId: MessageId.make(`bosun-handoff:${handoffId}:notice:${version}`),
              role: "user",
              text: prompt,
              attachments: [],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: ComposerContextId.make("bosun-origin"),
                    label: "Bosun",
                    kind: "bosun-bot",
                    payload: { botId: "Bosun", runId: recipientRunId, handoffId },
                  },
                ],
              },
            },
            runtimeMode,
            interactionMode: "default",
            createdAt,
          })
          .pipe(Effect.asVoid),
      interrupt: (threadId, handoffId, createdAt) =>
        engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`bosun-handoff:${handoffId}:interrupt`),
            threadId,
            createdAt,
          })
          .pipe(Effect.asVoid),
      listPendingStartedRunIds: (afterId, limit) =>
        sql<{ readonly id: string }>`
          SELECT DISTINCT r.id FROM bosun_bot_runs AS r
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
