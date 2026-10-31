// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  headquartersBotId,
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  CommandId,
  ComposerContextId,
  MessageId,
  ModelSelection,
  ThreadId,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type CrewTurnState,
  ThreadCrewHandoff,
  type ThreadCrewRequestTag,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { crewTurnStateFromStatus } from "./crewTurnState.ts";
import type { CrewWorkspace } from "./CrewStore.ts";
import type { FreshStartRecords } from "./headquartersFreshStart.ts";
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
  /** The worktree the thread opens in; the project's checkout when null. */
  readonly workspace: CrewWorkspace | null;
}

export interface CrewThreadRuntimeShape {
  readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean, CrewReadError>;
  /** The Scratch project bots keep their headquarters in, or null where there is none. */
  readonly headquartersProjectId: Effect.Effect<ProjectId | null>;
  /** Pins a crew thread once; the fixed command ID makes an unpin stick. */
  readonly pin: (
    threadId: ThreadId,
    commandId: string,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  /**
   * Brings a long-lived crew thread back: recreates and restarts it after a delete, or
   * unarchives it. A no-op while the thread is live.
   */
  readonly restore: (input: CrewThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
  /** Points the thread's next turns at `runtimeMode` and `modelSelection` when they differ. */
  readonly syncSettings: (
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  /** The thread's project and worktree, which helpers it delegates to inherit. */
  readonly workspace: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly workspace: CrewWorkspace | null } | null,
    OrchestrationDispatchError
  >;
  /** The access and model the thread's next turn uses, or null once it is gone. */
  readonly settings: (threadId: ThreadId) => Effect.Effect<
    {
      readonly runtimeMode: RuntimeMode;
      readonly modelSelection: ModelSelection;
    } | null,
    OrchestrationDispatchError
  >;
  readonly start: (input: CrewThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
  /** Each run that completes, in any thread. */
  readonly completedRuns: Stream.Stream<
    { readonly threadId: ThreadId; readonly runId: RunId },
    OrchestrationDispatchError
  >;
  readonly freshStartRecords: (
    threadId: ThreadId,
  ) => Effect.Effect<FreshStartRecords, OrchestrationDispatchError>;
  /**
   * Retires the thread's provider conversation and opens a fresh one with `prompt`. `key` names
   * this fresh start, so repeating it changes nothing.
   */
  readonly startFresh: (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly key: string;
    readonly prompt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
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
  /**
   * Tags a handoff's thread with the work its source thread is on: the source's feature, else
   * its bot request, else `request`, which starts a new one. Tags a thread at most once.
   */
  readonly tagHandoff: (input: {
    readonly threadId: ThreadId;
    readonly sourceThreadId: ThreadId;
    readonly request: ThreadCrewRequestTag;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
  /** Shows a thread the handoffs it sent that are still out; skipped when nothing changed. */
  readonly showHandoffs: (
    threadId: ThreadId,
    handoffs: ReadonlyArray<ThreadCrewHandoff>,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
}

const sameHandoffs = Schema.toEquivalence(Schema.Array(ThreadCrewHandoff));

export class CrewThreadRuntime extends Context.Service<CrewThreadRuntime, CrewThreadRuntimeShape>()(
  "t3/crew/CrewThreadRuntime",
) {}

// Existing bot threads keep their command namespace and durable receipts.
const runCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-run" : "bot-run";
const handoffCommandPrefix = (threadId: ThreadId) =>
  threadId.startsWith("bosun-run:") ? "bosun-handoff" : "bot-handoff";

const sameModelSelection = Schema.toEquivalence(ModelSelection);

export const CrewThreadRuntimeV2 = Layer.effect(
  CrewThreadRuntime,
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const launcher = yield* ThreadLaunchService.ThreadLaunchService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    // Optional so crew tests run without managed folders; the server always provides them.
    const folders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
    const origin = (input: CrewThreadStart) => ({
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          contextId: ComposerContextId.make("bot-origin"),
          label: input.memberId,
          kind: "bot" as const,
          payload: { memberId: input.memberId, runId: input.runId },
        },
      ],
    });
    // `suffix` gives a restart after a delete its own receipts.
    const submitTurn = (input: CrewThreadStart, suffix = "") =>
      engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(
            `${runCommandPrefix(input.threadId)}:${input.runId}:start${suffix}`,
          ),
          threadId: input.threadId,
          messageId: MessageId.make(
            `${runCommandPrefix(input.threadId)}:${input.runId}:message${suffix}`,
          ),
          text: input.prompt,
          attachments: [],
          context: origin(input),
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.asVoid);
    const create = (input: CrewThreadStart, suffix = "") =>
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(
          `${runCommandPrefix(input.threadId)}:${input.runId}:create${suffix}`,
        ),
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        branch: input.workspace?.branch ?? null,
        worktreePath: input.workspace?.worktreePath ?? null,
        createdBy: "agent",
        creationSource: "mcp",
      });
    /** Whether a thread other than `threadId` already works in `worktreePath`. */
    const worktreeInUse = (projectId: ProjectId, threadId: ThreadId, worktreePath: string) =>
      sql<{ readonly threadId: string }>`
        SELECT thread_id AS threadId FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId} AND thread_id <> ${threadId} AND deleted_at IS NULL
          AND json_extract(payload_json, '$.worktreePath') = ${worktreePath}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.worktreeInUse")),
      );
    // A headquarters keeps its direct path, which `restore` also takes after a delete.
    const startHeadquarters = Effect.fn("CrewThreadRuntime.startHeadquarters")(function* (
      input: CrewThreadStart,
    ) {
      const existing = yield* engine.getThreadShell(input.threadId);
      if (existing === null) yield* create(input);
      yield* submitTurn(input);
    });
    // Untraced: `start` is its span.
    const launch = Effect.fnUntraced(function* (input: CrewThreadStart, commandId: CommandId) {
      const prefix = runCommandPrefix(input.threadId);
      const workspace = input.workspace;
      // The first thread in a worktree runs the project's setup script; later ones reuse it.
      const inUse =
        workspace !== null &&
        (yield* worktreeInUse(input.projectId, input.threadId, workspace.worktreePath));
      yield* launcher.launch({
        commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: workspace
          ? { type: "existing_worktree", ...workspace }
          : { type: "root" },
        runSetupScript: !inUse,
        initialMessage: {
          messageId: MessageId.make(`${prefix}:${input.runId}:message`),
          text: input.prompt,
          attachments: [],
          context: origin(input),
        },
        createdBy: "agent",
        creationSource: "mcp",
      });
    });
    const start = Effect.fn("CrewThreadRuntime.start")(function* (input: CrewThreadStart) {
      if (headquartersBotId(input.threadId) !== null) return yield* startHeadquarters(input);
      // The direct path created threads under this ID, so a run it began replays here.
      const commandId = CommandId.make(`${runCommandPrefix(input.threadId)}:${input.runId}:create`);
      yield* launch(input, commandId).pipe(
        Effect.mapError(
          (cause) =>
            new Orchestrator.OrchestratorDispatchError({
              commandId,
              commandType: "thread.create",
              cause,
            }),
        ),
      );
    });
    // Each restore and settings change is a new decision, so it gets a fresh command ID.
    let sequence = 0;
    const freshId = DateTime.now.pipe(
      Effect.map((now) => `${DateTime.toEpochMillis(now)}-${++sequence}`),
    );
    const restore = Effect.fn("CrewThreadRuntime.restore")(function* (input: CrewThreadStart) {
      const shell = yield* engine.getThreadShell(input.threadId);
      if (shell === null || shell.deletedAt !== null) {
        const suffix = `:restore:${yield* freshId}`;
        yield* create(input, suffix);
        yield* submitTurn(input, suffix);
        yield* engine.dispatch({
          type: "thread.pin",
          commandId: CommandId.make(`${input.runId}:pin${suffix}`),
          threadId: input.threadId,
        });
      } else if (shell.archivedAt !== null) {
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`${input.runId}:unarchive:${yield* freshId}`),
          threadId: input.threadId,
        });
      }
    });
    const syncSettings = Effect.fn("CrewThreadRuntime.syncSettings")(function* (
      threadId: ThreadId,
      runtimeMode: RuntimeMode,
      modelSelection: ModelSelection,
    ) {
      const shell = yield* engine.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return;
      if (shell.runtimeMode !== runtimeMode)
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${threadId}:runtime-mode:${yield* freshId}`),
          threadId,
          runtimeMode,
        });
      if (!sameModelSelection(shell.modelSelection, modelSelection))
        yield* engine.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:model:${yield* freshId}`),
          threadId,
          modelSelection,
        });
    });
    const tagHandoff = Effect.fn("CrewThreadRuntime.tagHandoff")(function* (input: {
      readonly threadId: ThreadId;
      readonly sourceThreadId: ThreadId;
      readonly request: ThreadCrewRequestTag;
    }) {
      const thread = yield* engine.getThreadShell(input.threadId);
      if (thread === null || thread.feature || thread.crewRequest) return;
      const source = yield* engine.getThreadShell(input.sourceThreadId);
      yield* engine.dispatch({
        type: "thread.crew-stage.set",
        commandId: CommandId.make(`${handoffCommandPrefix(input.threadId)}:${input.threadId}:tag`),
        threadId: input.threadId,
        // A helper inside a feature keeps the request too, which names its role and tells it
        // apart from the feature's lead.
        ...(source?.feature ? { feature: source.feature } : {}),
        crewRequest: source?.crewRequest
          ? { ...source.crewRequest, member: input.request.member }
          : input.request,
      });
    });
    const showHandoffs = Effect.fn("CrewThreadRuntime.showHandoffs")(function* (
      threadId: ThreadId,
      handoffs: ReadonlyArray<ThreadCrewHandoff>,
    ) {
      const thread = yield* engine.getThreadShell(threadId);
      if (thread === null) return;
      if (sameHandoffs(thread.crewHandoffs ?? [], handoffs)) return;
      yield* engine.dispatch({
        type: "thread.crew-stage.set",
        // A list can return to an earlier value, so each change needs its own receipt.
        commandId: CommandId.make(`crew-handoffs:${threadId}:${NodeCrypto.randomUUID()}`),
        threadId,
        crewHandoffs: handoffs,
      });
    });
    return CrewThreadRuntime.of({
      tagHandoff,
      showHandoffs,
      projectExists: Effect.fn("CrewThreadRuntime.projectExists")((projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(Option.isSome),
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.projectExists")),
          ),
      ),
      headquartersProjectId: Option.match(folders, {
        onNone: () => Effect.succeed(null),
        onSome: (managed) =>
          managed.ensureScratchProject.pipe(
            Effect.map(({ projectId }) => projectId),
            Effect.catch((error) =>
              Effect.logWarning("Scratch project unavailable", { error }).pipe(Effect.as(null)),
            ),
          ),
      }),
      pin: Effect.fn("CrewThreadRuntime.pin")((threadId, commandId) =>
        engine
          .dispatch({ type: "thread.pin", commandId: CommandId.make(commandId), threadId })
          .pipe(Effect.asVoid),
      ),
      restore,
      syncSettings,
      workspace: Effect.fn("CrewThreadRuntime.workspace")(function* (threadId) {
        const shell = yield* engine.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return null;
        return {
          projectId: shell.projectId,
          workspace:
            shell.branch && shell.worktreePath
              ? { branch: shell.branch, worktreePath: shell.worktreePath }
              : null,
        };
      }),
      settings: Effect.fn("CrewThreadRuntime.settings")(function* (threadId) {
        const shell = yield* engine.getThreadShell(threadId);
        return shell === null || shell.deletedAt !== null
          ? null
          : { runtimeMode: shell.runtimeMode, modelSelection: shell.modelSelection };
      }),
      start,
      completedRuns: engine.streamDomainEvents.pipe(
        Stream.filterMap((event) =>
          event.type === "run.updated" && event.payload.status === "completed"
            ? Result.succeed({ threadId: event.threadId, runId: event.payload.id })
            : Result.failVoid,
        ),
      ),
      freshStartRecords: Effect.fn("CrewThreadRuntime.freshStartRecords")((threadId) =>
        engine.getThreadRecords(
          threadId,
          ["runs", "runtimeRequests", "providerThreads", "providerTurns", "messages"],
          { messageRoles: ["user", "assistant"] },
        ),
      ),
      startFresh: Effect.fn("CrewThreadRuntime.startFresh")(function* (input) {
        const prefix = `${runCommandPrefix(input.threadId)}:${input.runId}:fresh:${input.key}`;
        yield* engine.dispatch({
          type: "thread.conversation.restart",
          commandId: CommandId.make(prefix),
          threadId: input.threadId,
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${prefix}:brief`),
          threadId: input.threadId,
          messageId: MessageId.make(`${prefix}:brief`),
          text: input.prompt,
          attachments: [],
          context: {
            version: 1,
            records: [
              {
                version: 1,
                contextId: ComposerContextId.make("bot-origin"),
                label: "Fresh start",
                kind: "bot",
                payload: { memberId: "crew", runId: input.runId },
              },
            ],
          },
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: "queue_after_active" },
        });
      }),
      // V2 owns accepted-run recovery through the durable effect outbox. Reusing
      // the original receipts only fills a crash between thread creation and start.
      replayPending: Effect.fn("CrewThreadRuntime.replayPending")((input) => start(input)),
      notify: Effect.fn("CrewThreadRuntime.notify")(
        (threadId, handoffId, version, recipientRunId, _runtimeMode, prompt, _createdAt) =>
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
      ),
      interrupt: Effect.fn("CrewThreadRuntime.interrupt")(
        function* (threadId, handoffId, _createdAt) {
          // Cancel the queue first: interrupting the active run starts the next queued one.
          const { runs } = yield* engine.getThreadRecords(threadId, ["runs"]);
          for (const run of runs) {
            // A preparing run is the active one, which the interrupt below stops.
            if (run.status !== "queued") continue;
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
        },
      ),
      listPendingStartedRunIds: Effect.fn("CrewThreadRuntime.listPendingStartedRunIds")(
        (afterId, limit) =>
          sql<{ readonly id: string }>`
      SELECT r.id FROM crew_runs AS r WHERE r.dispatch_state = ${CREW_DISPATCH_STATE.STARTED}
        AND r.id > ${afterId} AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS t WHERE t.thread_id = r.thread_id
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_legacy_imports AS legacy WHERE legacy.thread_id = r.thread_id
        ) ORDER BY r.id LIMIT ${limit}
    `.pipe(
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.listPendingStartedRunIds")),
            Effect.map((rows) => rows.map((row) => row.id)),
          ),
      ),
      getTurnState: Effect.fn("CrewThreadRuntime.getTurnState")(
        function* (threadId) {
          const runs = yield* sql<{ readonly status: string }>`
          SELECT status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1
        `;
          if (runs[0]) return crewTurnStateFromStatus(runs[0].status);
          // Imported V1 threads have no V2 runs. Their work ended with the V1
          // runtime, so treat it as done and never restart it.
          const legacy = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM orchestration_v2_legacy_imports
          WHERE thread_id = ${threadId}
        `;
          if (legacy[0]) return CREW_TURN_STATE.COMPLETED;
          const thread = yield* engine.getThreadShell(threadId);
          return thread === null ? CREW_TURN_STATE.MISSING : CREW_TURN_STATE.PENDING;
        },
        Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.getTurnState")),
      ),
    });
  }),
);
