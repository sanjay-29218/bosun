import {
  ChatAttachment,
  OrchestrationMessageContext,
  isStandingThread,
  BOT_FRESH_START_LABEL,
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  CommandId,
  ComposerContextId,
  MessageId,
  ModelSelection,
  ThreadId,
  type ProjectId,
  type ProjectRemoteManager,
  type RuntimeMode,
  type CrewTurnState,
} from "@t3tools/contracts";
import {
  resolveDefaultModelSelection,
  resolveRunModelSelection,
} from "@t3tools/shared/providerDefaultModel";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { crewTurnStateFromStatus } from "./crewTurnState.ts";
import type { CrewWorkspace } from "./CrewStore.ts";
import { headquartersIdle, type FreshStartRecords } from "./headquartersFreshStart.ts";
type OrchestrationDispatchError = Orchestrator.OrchestratorV2Error;
type CrewReadError = PersistenceSqlError;
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export const OpeningMessage = Schema.Struct({
  attachments: Schema.Array(ChatAttachment),
  context: Schema.optionalKey(OrchestrationMessageContext),
});
export type OpeningMessage = typeof OpeningMessage.Type;
const openingMessageJson = Schema.fromJsonString(OpeningMessage);
export const encodeOpeningMessage = (message: OpeningMessage | null | undefined) =>
  message ? Schema.encodeSync(openingMessageJson)(message) : null;
export const decodeOpeningMessage = (json: string | null): OpeningMessage | null =>
  json === null ? null : Schema.decodeSync(openingMessageJson)(json);

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
  readonly openingMessage?: OpeningMessage | null;
}

export type RunModel = NonNullable<ReturnType<typeof resolveRunModelSelection>>;

export interface CrewThreadRuntimeShape {
  readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean, CrewReadError>;
  /** Where the project's manager lives when it isn't here; null for here. */
  readonly projectRemoteManager: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectRemoteManager | null, CrewReadError>;
  /** The bot that owns the project, null when it has none or is gone. */
  readonly projectBotId: (projectId: ProjectId) => Effect.Effect<string | null, CrewReadError>;
  /**
   * The model the project's work defaults to: the project's own, else this environment's, else
   * the one a new thread there gets from the first usable provider. Null when none can run.
   */
  readonly projectModelSelection: (
    projectId: ProjectId,
  ) => Effect.Effect<ModelSelection | null, CrewReadError>;
  /**
   * The model one run in the project uses: `chosen`, else the project's default, switched to the
   * fallback model while that one can't run here. Never saved on the agent. Null when no
   * provider can run.
   */
  readonly runModelSelection: (
    projectId: ProjectId,
    chosen: ModelSelection | null,
    roleFallback?: ModelSelection | null,
  ) => Effect.Effect<RunModel | null, CrewReadError>;
  /**
   * Shows `notice` in the thread's latest run while it is unfinished and runs on `selection`; an
   * idle thread's header already shows its model.
   */
  readonly noteModelFallback: (
    threadId: ThreadId,
    selection: ModelSelection,
    notice: NonNullable<RunModel["notice"]> & { readonly level?: "info" | "error" },
  ) => Effect.Effect<void>;
  /** Scratch or a bot's home, which never get a Project manager. */
  readonly isHiddenProject: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** The bot's home project, made on first use; its headquarters works there. */
  readonly botHome: (bot: {
    readonly id: string;
    readonly name: string;
  }) => Effect.Effect<ProjectId, ManagedProjectFolders.BotHomeError>;
  /**
   * Moves an idle thread into `projectId` and retires its provider conversation in one
   * decision, so its next turn starts a fresh session there. Starts no turn. False while the
   * thread works; a later call tries again. Moving a thread that is already there changes
   * nothing.
   */
  readonly moveThread: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly key: string;
  }) => Effect.Effect<boolean, OrchestrationDispatchError>;
  /** Pins a crew thread once; the fixed command ID makes an unpin stick. */
  readonly pin: (
    threadId: ThreadId,
    commandId: string,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  /** Unpins a crew thread once; the fixed command ID makes a later pin stick. */
  readonly unpin: (
    threadId: ThreadId,
    commandId: string,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  /**
   * Brings a long-lived crew thread back: recreates it, with no turn, after a delete, or
   * unarchives it. A no-op while the thread is live.
   */
  readonly restore: (input: CrewThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
  /** Archives a crew thread; a no-op when it is gone or already archived. */
  readonly archive: (threadId: ThreadId) => Effect.Effect<void, OrchestrationDispatchError>;
  /**
   * Points the thread's next turns at `modelSelection`; with `from`, only while the thread is on
   * that model, so a model picked in its composer stays. True when the model changed.
   */
  readonly setModel: (
    threadId: ThreadId,
    modelSelection: ModelSelection,
    options?: { readonly from: ModelSelection },
  ) => Effect.Effect<boolean, OrchestrationDispatchError>;
  readonly start: (input: CrewThreadStart) => Effect.Effect<void, OrchestrationDispatchError>;
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

const sameModelSelection = Schema.toEquivalence(ModelSelection);
const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const CrewThreadRuntimeV2 = Layer.effect(
  CrewThreadRuntime,
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const launcher = yield* ThreadLaunchService.ThreadLaunchService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
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
        ...(input.openingMessage?.context?.records ?? []),
      ],
    });
    // `suffix` gives a restore after a delete its own receipts.
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
        worktreePath:
          input.workspace && "worktreePath" in input.workspace
            ? input.workspace.worktreePath
            : null,
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
    // A standing thread opens with no turn: its instructions ride along with the first message
    // that reaches it (see StandingBriefing), so opening one costs nothing.
    const startHeadquarters = Effect.fn("CrewThreadRuntime.startHeadquarters")(function* (
      input: CrewThreadStart,
    ) {
      const existing = yield* engine.getThreadShell(input.threadId);
      if (existing === null) yield* create(input);
    });
    // Untraced: `start` is its span.
    const launch = Effect.fnUntraced(function* (input: CrewThreadStart, commandId: CommandId) {
      const prefix = runCommandPrefix(input.threadId);
      const workspace = input.workspace;
      // The first thread in a worktree runs the project's setup script; later ones reuse it.
      const inUse =
        workspace !== null &&
        "worktreePath" in workspace &&
        (yield* worktreeInUse(input.projectId, input.threadId, workspace.worktreePath));
      yield* launcher.launch({
        commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy:
          workspace === null
            ? { type: "root" }
            : "worktreePath" in workspace
              ? { type: "existing_worktree", ...workspace }
              : { type: "worktree", ...workspace },
        runSetupScript: !inUse,
        initialMessage: {
          messageId: MessageId.make(`${prefix}:${input.runId}:message`),
          text: input.prompt,
          attachments: input.openingMessage?.attachments ?? [],
          context: origin(input),
        },
        createdBy: "agent",
        creationSource: "mcp",
      });
    });
    const start = Effect.fn("CrewThreadRuntime.start")(function* (input: CrewThreadStart) {
      if (isStandingThread(input.threadId)) return yield* startHeadquarters(input);
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
        yield* create(input, `:restore:${yield* freshId}`);
      } else if (shell.archivedAt !== null) {
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`${input.runId}:unarchive:${yield* freshId}`),
          threadId: input.threadId,
        });
      }
    });
    const setModel = Effect.fn("CrewThreadRuntime.setModel")(function* (
      threadId: ThreadId,
      modelSelection: ModelSelection,
      options?: { readonly from: ModelSelection },
    ) {
      const shell = yield* engine.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return false;
      if (options !== undefined && !sameModelSelection(shell.modelSelection, options.from))
        return false;
      if (sameModelSelection(shell.modelSelection, modelSelection)) return false;
      yield* engine.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:model:${yield* freshId}`),
        threadId,
        modelSelection,
      });
      return true;
    });
    return CrewThreadRuntime.of({
      projectExists: Effect.fn("CrewThreadRuntime.projectExists")((projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(Option.isSome),
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.projectExists")),
          ),
      ),
      projectRemoteManager: Effect.fn("CrewThreadRuntime.projectRemoteManager")((projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(
              Option.match({ onNone: () => null, onSome: (project) => project.remoteManager }),
            ),
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.projectRemoteManager")),
          ),
      ),
      projectBotId: Effect.fn("CrewThreadRuntime.projectBotId")((projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.botId })),
            Effect.mapError(toPersistenceSqlError("CrewThreadRuntime.projectBotId")),
          ),
      ),
      projectModelSelection: Effect.fn("CrewThreadRuntime.projectModelSelection")(
        function* (projectId) {
          const readError = toPersistenceSqlError("CrewThreadRuntime.projectModelSelection");
          const project = yield* projects.get(projectId).pipe(Effect.mapError(readError));
          const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(readError));
          return resolveDefaultModelSelection(
            yield* providerRegistry.getProviders,
            settings,
            projectId,
            Option.getOrNull(project),
          );
        },
      ),
      runModelSelection: Effect.fn("CrewThreadRuntime.runModelSelection")(
        function* (projectId, chosen, roleFallback) {
          const readError = toPersistenceSqlError("CrewThreadRuntime.runModelSelection");
          const project = Option.getOrNull(
            yield* projects.get(projectId).pipe(Effect.mapError(readError)),
          );
          const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(readError));
          return resolveRunModelSelection({
            chosen,
            roleFallback: roleFallback ?? null,
            providers: yield* providerRegistry.getProviders,
            settings,
            projectId,
            project,
            now: DateTime.toEpochMillis(yield* DateTime.now),
          });
        },
      ),
      noteModelFallback: Effect.fn("CrewThreadRuntime.noteModelFallback")(
        function* (threadId, selection, notice) {
          const { runs } = yield* engine.getThreadRecords(threadId, ["runs"]);
          const run = runs.reduce<(typeof runs)[number] | undefined>(
            (latest, candidate) =>
              latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
            undefined,
          );
          if (
            run === undefined ||
            FINISHED_RUN_STATUSES.has(run.status) ||
            !sameModelSelection(run.modelSelection, selection)
          )
            return;
          yield* launcher.recordNotice({
            threadId,
            runId: run.id,
            signal: "model-fallback",
            title: notice.title,
            message: notice.message,
            level: notice.level ?? "info",
          });
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not show the fallback model notice", { cause }),
        ),
      ),
      isHiddenProject: Effect.fn("CrewThreadRuntime.isHiddenProject")((projectId) =>
        Option.match(folders, {
          onNone: () => Effect.succeed(false),
          onSome: (managed) => managed.isHiddenProject(projectId),
        }),
      ),
      botHome: Effect.fn("CrewThreadRuntime.botHome")(function* (bot) {
        if (Option.isNone(folders)) {
          return yield* new ManagedProjectFolders.BotHomeError({
            botId: bot.id,
            cause: "Bot homes are not available on this environment.",
          });
        }
        return (yield* folders.value.ensureBotHome(bot)).projectId;
      }),
      moveThread: Effect.fn("CrewThreadRuntime.moveThread")(function* (input) {
        const shell = yield* engine.getThreadShell(input.threadId);
        if (shell === null || shell.deletedAt !== null) return true;
        // A fresh ID per attempt: a refusal while the thread works is recorded under its
        // command ID, and must not refuse the next attempt.
        return yield* engine
          .dispatch({
            type: "thread.project.move",
            commandId: CommandId.make(`${input.key}:${yield* freshId}`),
            threadId: input.threadId,
            projectId: input.projectId,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              engine
                .getThreadRecords(input.threadId, ["runs", "runtimeRequests"])
                .pipe(
                  Effect.flatMap((records) =>
                    headquartersIdle(records) ? Effect.fail(error) : Effect.succeed(false),
                  ),
                ),
            ),
          );
      }),
      pin: Effect.fn("CrewThreadRuntime.pin")((threadId, commandId) =>
        engine
          .dispatch({ type: "thread.pin", commandId: CommandId.make(commandId), threadId })
          .pipe(Effect.asVoid),
      ),
      unpin: Effect.fn("CrewThreadRuntime.unpin")((threadId, commandId) =>
        engine
          .dispatch({ type: "thread.unpin", commandId: CommandId.make(commandId), threadId })
          .pipe(Effect.asVoid),
      ),
      restore,
      archive: Effect.fn("CrewThreadRuntime.archive")(function* (threadId) {
        const shell = yield* engine.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`${threadId}:archive:${yield* freshId}`),
          threadId,
        });
      }),
      setModel,
      start,
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
                label: BOT_FRESH_START_LABEL,
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
