import {
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  CommandId,
  ComposerContextId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type CrewTurnState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { crewTurnStateFromStatus } from "./crewTurnState.ts";
type OrchestrationDispatchError = Orchestrator.OrchestratorV2Error;
type CrewReadError = PersistenceSqlError;
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface CrewThreadStart {
  readonly runId: string;
  readonly memberId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}

export interface CrewThreadRuntimeShape {
  readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean, CrewReadError>;
  readonly start: (input: CrewThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly replayPending: (
    input: CrewThreadStart,
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
  readonly getTurnState: (threadId: ThreadId) => Effect.Effect<CrewTurnState, CrewReadError>;
}

export class CrewThreadRuntime extends Context.Service<CrewThreadRuntime, CrewThreadRuntimeShape>()(
  "t3/crew/CrewThreadRuntime",
) {}

// Existing bot threads keep their command namespace and durable receipts.
const runCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-run" : "bot-run";
const handoffCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-handoff" : "bot-handoff";

export const CrewThreadRuntimeV2 = Layer.effect(
  CrewThreadRuntime,
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const submitTurn = (input: CrewThreadStart) =>
      engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${runCommandPrefix(input.threadId)}:${input.runId}:start`),
          threadId: input.threadId,
          messageId: MessageId.make(`${runCommandPrefix(input.threadId)}:${input.runId}:message`),
          text: input.prompt,
          attachments: [],
          context: {
            version: 1,
            records: [
              {
                version: 1,
                contextId: ComposerContextId.make("bot-origin"),
                label: input.memberId,
                kind: "bot",
                payload: { memberId: input.memberId, runId: input.runId },
              },
            ],
          },
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.asVoid);
    const start = Effect.fn("CrewThreadRuntime.start")(function* (input: CrewThreadStart) {
      const existing = yield* engine.getThreadShell(input.threadId);
      if (existing === null)
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${runCommandPrefix(input.threadId)}:${input.runId}:create`),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* submitTurn(input);
    });
    return CrewThreadRuntime.of({
      projectExists: (projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(Option.isSome),
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.projectExists")),
          ),
      start,
      // V2 owns accepted-run recovery through the durable effect outbox. Reusing
      // the original receipts only fills a crash between thread creation and start.
      replayPending: (input) => start(input),
      notify: (threadId, handoffId, version, recipientRunId, _runtimeMode, prompt, _createdAt) =>
        engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(
              `${handoffCommandPrefix(threadId)}:${handoffId}:notice:${version}`,
            ),
            threadId,
            messageId: MessageId.make(
              `${handoffCommandPrefix(threadId)}:${handoffId}:notice:${version}`,
            ),
            text: prompt,
            attachments: [],
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("bot-origin"),
                  label: "Crew",
                  kind: "bot",
                  payload: { memberId: "crew", runId: recipientRunId, handoffId },
                },
              ],
            },
            createdBy: "agent",
            creationSource: "mcp",
            dispatchMode: { type: "queue_after_active" },
          })
          .pipe(Effect.asVoid),
      interrupt: (threadId, handoffId, _createdAt) =>
        Effect.gen(function* () {
          // Cancel the queue first: interrupting the active run starts the next queued one.
          const { runs } = yield* engine.getThreadRecords(threadId, ["runs"]);
          for (const run of runs) {
            if (run.status !== "queued" && run.status !== "preparing") continue;
            yield* engine.dispatch({
              type: "queued-run.cancel",
              threadId,
              runId: run.id,
              commandId: CommandId.make(
                `${handoffCommandPrefix(threadId)}:${handoffId}:cancel:${run.id}`,
              ),
            });
          }
          const shell = yield* engine.getThreadShell(threadId);
          if (shell?.activeRunId)
            yield* engine.dispatch({
              type: "run.interrupt",
              threadId,
              runId: shell.activeRunId,
              commandId: CommandId.make(`${handoffCommandPrefix(threadId)}:${handoffId}:interrupt`),
            });
        }),
      listPendingStartedRunIds: (afterId, limit) =>
        sql<{ readonly id: string }>`
      SELECT r.id FROM crew_runs AS r WHERE r.dispatch_state = ${CREW_DISPATCH_STATE.STARTED}
        AND r.id > ${afterId} AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS t WHERE t.thread_id = r.thread_id
        ) AND NOT EXISTS (
          SELECT 1 FROM projection_turns AS legacy WHERE legacy.thread_id = r.thread_id
        ) ORDER BY r.id LIMIT ${limit}
    `.pipe(
          Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.listPendingStartedRunIds")),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
      getTurnState: (threadId) =>
        Effect.gen(function* () {
          const runs = yield* sql<{ readonly status: string }>`
          SELECT status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1
        `.pipe(Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.getTurnState")));
          if (runs[0]) return crewTurnStateFromStatus(runs[0].status);
          // V1 transcripts import lazily, without V2 runs. Never restart accepted V1 work.
          const legacy = yield* sql<{ readonly state: string }>`
          SELECT state FROM projection_turns WHERE thread_id = ${threadId}
          ORDER BY requested_at DESC, row_id DESC LIMIT 1
        `.pipe(Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.getTurnState")));
          if (legacy[0]) {
            if (legacy[0].state === "completed") return CREW_TURN_STATE.COMPLETED;
            if (legacy[0].state === "error") return CREW_TURN_STATE.ERROR;
            return CREW_TURN_STATE.INTERRUPTED;
          }
          const thread = yield* engine
            .getThreadShell(threadId)
            .pipe(Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.getTurnState")));
          return thread === null ? CREW_TURN_STATE.MISSING : CREW_TURN_STATE.PENDING;
        }),
    });
  }),
);
