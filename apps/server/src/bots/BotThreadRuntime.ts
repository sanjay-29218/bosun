import {
  BOT_DISPATCH_STATE,
  BOT_TURN_STATE,
  CommandId,
  ComposerContextId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type BotTurnState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../orchestration/Errors.ts";
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
  ) => Effect.Effect<BotTurnState, ProjectionRepositoryError>;
}

export class BotThreadRuntime extends Context.Service<BotThreadRuntime, BotThreadRuntimeShape>()(
  "t3/bots/BotThreadRuntime",
) {}

// Existing bot threads keep their original command namespace so restart replay finds receipts.
const runCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-run" : "bot-run";
const handoffCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-handoff" : "bot-handoff";

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
            messageId: MessageId.make(
              pending?.messageId ?? `${runCommandPrefix(input.threadId)}:${input.runId}:message`,
            ),
            role: "user",
            text: pending?.text ?? input.prompt,
            attachments: [],
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("bot-origin"),
                  label: input.botId,
                  kind: "bot",
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
          const contexts = yield* sql<{
            path: string | null;
            branch: string | null;
            phase: string;
          }>`
            SELECT c.path, c.branch, c.phase FROM feature_checkouts c
            WHERE c.feature_id = COALESCE(
              (SELECT feature_id FROM feature_run_links WHERE run_id = ${input.runId} AND kind = 'task'),
              (SELECT feature_id FROM bots WHERE id = ${input.botId}
                AND NOT EXISTS (SELECT 1 FROM feature_run_links WHERE run_id = ${input.runId} AND kind = 'coordination')))
          `.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationCommandInvariantError({
                  commandType: "thread.create",
                  detail: "Cannot read the feature checkout",
                  cause,
                }),
            ),
          );
          const checkout = contexts[0];
          if (checkout && checkout.phase !== "ready")
            return yield* new OrchestrationCommandInvariantError({
              commandType: "thread.create",
              detail: "Feature checkout is not ready; retry its setup first",
            });
          // Command receipts make these fixed IDs safe to replay after either dispatch.
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${runCommandPrefix(input.threadId)}:${input.runId}:create`),
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            branch: checkout?.branch ?? null,
            worktreePath: checkout?.path ?? null,
            createdAt: input.createdAt,
          });
          yield* submitTurn(input, `${runCommandPrefix(input.threadId)}:${input.runId}:start`);
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
              ? submitTurn(
                  input,
                  `${runCommandPrefix(input.threadId)}:${input.runId}:replay:${recoveryAttempt}`,
                  rows[0],
                )
              : Effect.void,
          ),
        ),
      notify: (threadId, handoffId, version, recipientRunId, runtimeMode, prompt, createdAt) =>
        engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(
              `${handoffCommandPrefix(threadId)}:${handoffId}:notice:${version}`,
            ),
            threadId,
            message: {
              messageId: MessageId.make(
                `${handoffCommandPrefix(threadId)}:${handoffId}:notice:${version}`,
              ),
              role: "user",
              text: prompt,
              attachments: [],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: ComposerContextId.make("bot-origin"),
                    label: "Bot",
                    kind: "bot",
                    payload: { botId: "Bot", runId: recipientRunId, handoffId },
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
            commandId: CommandId.make(`${handoffCommandPrefix(threadId)}:${handoffId}:interrupt`),
            threadId,
            createdAt,
          })
          .pipe(Effect.asVoid),
      listPendingStartedRunIds: (afterId, limit) =>
        sql<{ readonly id: string }>`
          SELECT DISTINCT r.id FROM bot_runs AS r
          JOIN projection_turns AS t ON t.thread_id = r.thread_id AND t.state = 'pending'
          LEFT JOIN projection_thread_sessions AS s ON s.thread_id = r.thread_id
          WHERE r.dispatch_state = ${BOT_DISPATCH_STATE.STARTED}
            AND s.thread_id IS NULL AND r.id > ${afterId}
          ORDER BY r.id LIMIT ${limit}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("BotThreadRuntime.listPendingStartedRunIds")),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
      getTurnState: (threadId) =>
        query.getThreadShellById(threadId).pipe(
          Effect.map((thread) => {
            if (Option.isNone(thread)) return BOT_TURN_STATE.MISSING;
            const state = thread.value.latestTurn?.state;
            return state ?? BOT_TURN_STATE.PENDING;
          }),
        ),
    } satisfies BotThreadRuntimeShape;
  }),
);
