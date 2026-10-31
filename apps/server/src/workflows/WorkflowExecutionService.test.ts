// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Run,
  type ThreadId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import { CrewService, CrewServiceLive } from "../crew/CrewService.ts";
import { CrewStoreLive } from "../crew/CrewStore.ts";
import { CrewThreadRuntime, type CrewThreadStart } from "../crew/CrewThreadRuntime.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CrewTestOrchestration as OrchestrationLayerLive,
  seedCrewProject,
} from "../crew/CrewRuntime.testkit.ts";
import {
  OrchestratorDispatchError as OrchestrationCommandInvariantError,
  OrchestratorV2,
} from "../orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { WorkflowLibraryLive } from "./WorkflowLibrary.ts";
import { WorkflowService, WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowStore, WorkflowStoreLive } from "./WorkflowStore.ts";
import { WorkflowExecutionStoreLive } from "./WorkflowExecutionStore.ts";
import {
  WorkflowExecutionService,
  WorkflowExecutionServiceLive,
} from "./WorkflowExecutionService.ts";
import { renderStageHandoff } from "./StageHandoff.ts";
import { FeatureWorkspacesLive } from "../features/FeatureWorkspaces.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorkflowStageHandoffStoreLive } from "./WorkflowStageHandoffStore.ts";
import { WorkflowWorkspace, type StageThreadDiff } from "./WorkflowWorkspace.ts";

const projectId = ProjectId.make("execution-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

const fixture = (
  directory: string,
  crew: { readonly maxRunningStageThreads?: number; readonly stageRetries?: number } = {},
) => {
  const starts: Array<CrewThreadStart> = [];
  const worktrees: Array<string> = [];
  const git = Layer.mock(GitWorkflowService)({
    currentBranch: () => Effect.succeed("main"),
    createWorktree: (input) =>
      Effect.sync(() => {
        const branch = input.newRefName!;
        worktrees.push(branch);
        return { worktree: { path: `/worktrees/${branch}`, refName: branch } };
      }),
  });
  const interruptions: Array<string> = [];
  const stops = new Set<string>();
  let failDispatch = false;
  let failInterrupt = false;
  let duringDispatch: ((input: CrewThreadStart) => Effect.Effect<void>) | null = null;
  // Opens each stage's thread without a turn, so the stage waits for what a test reports.
  const runtime = Layer.effect(
    CrewThreadRuntime,
    Effect.gen(function* () {
      const engine = yield* OrchestratorV2;
      return CrewThreadRuntime.of({
        projectExists: () => Effect.succeed(true),
        headquartersProjectId: Effect.succeed(null),
        restore: () => Effect.void,
        syncSettings: () => Effect.void,
        completedRuns: Stream.empty,
        freshStartRecords: () => Effect.die("unused"),
        startFresh: () => Effect.void,
        pin: () => Effect.void,
        start: (input) =>
          Effect.gen(function* () {
            if (failDispatch && input.runId.startsWith("bot-handoff:workflow:")) {
              failDispatch = false;
              return yield* new OrchestrationCommandInvariantError({
                commandId: CommandId.make("test"),
                commandType: "message.dispatch",
                cause: "Dispatch unavailable",
              });
            }
            if (!starts.some((start) => start.runId === input.runId)) starts.push(input);
            if ((yield* engine.getThreadShell(input.threadId).pipe(Effect.orDie)) === null) {
              yield* engine
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make(`create:${input.threadId}`),
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
                })
                .pipe(Effect.orDie);
            }
            if (duringDispatch) yield* duringDispatch(input);
          }),
        replayPending: () => Effect.void,
        interrupt: (threadId, key) =>
          Effect.gen(function* () {
            if (failInterrupt) {
              failInterrupt = false;
              return yield* new OrchestrationCommandInvariantError({
                commandId: CommandId.make("test"),
                commandType: "message.dispatch",
                cause: "Interrupt unavailable",
              });
            }
            // The runtime's command IDs make a repeated stop a no-op.
            if (!stops.has(`${threadId}:${key}`)) interruptions.push(threadId);
            stops.add(`${threadId}:${key}`);
          }),
        listPendingStartedRunIds: () => Effect.succeed([]),
        getTurnState: () => Effect.succeed("running"),
      });
    }),
  );
  const files = new Set<string>();
  const diffs = new Map<string, StageThreadDiff>();
  const workspace = Layer.succeed(
    WorkflowWorkspace,
    WorkflowWorkspace.of({
      describe: (_projectId, worktreePath, paths) =>
        Effect.succeed({
          cwd: worktreePath ?? "/repo",
          branch: "crew/feature",
          commit: "0123456789abcdef0123",
          existing: new Set(paths.filter((path) => files.has(path))),
        }),
      threadDiff: (threadId) => Effect.succeed(diffs.get(threadId) ?? null),
    }),
  );
  const foundation = CrewServiceLive.pipe(
    Layer.provideMerge(CrewStoreLive),
    Layer.provideMerge(runtime),
    Layer.provideMerge(BotStore.layer),
    Layer.provideMerge(WorkflowLibraryLive),
  );
  const bots = FeatureWorkspacesLive.pipe(Layer.provide(git), Layer.provideMerge(foundation));
  const workflows = WorkflowServiceLive.pipe(
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(WorkflowStageHandoffStoreLive),
    Layer.provideMerge(workspace),
    Layer.provideMerge(bots),
  );
  const execution = WorkflowExecutionServiceLive.pipe(
    Layer.provideMerge(WorkflowExecutionStoreLive),
    Layer.provideMerge(workflows),
  );
  const layer = execution.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    // Stateless over SQLite; `endTurn` writes turn ends through it.
    Layer.provideMerge(ProjectionStore.layer),
    // The orchestrator's own outbox, which a restart queues its continuation in.
    Layer.provideMerge(EffectOutbox.layer),
    Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "workflow-execution-" })),
    Layer.provideMerge(ServerSettingsService.layerTest({ crew })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    starts,
    worktrees,
    interruptions,
    files,
    diffs,
    failNextDispatch: () => {
      failDispatch = true;
    },
    failNextInterrupt: () => {
      failInterrupt = true;
    },
    onDispatch: (callback: (input: CrewThreadStart) => Effect.Effect<void>) => {
      duringDispatch = callback;
    },
  };
};

const seed = (
  featureId = "feature-one",
  options: { readonly decisions?: "lead"; readonly gate?: boolean } = {},
) =>
  Effect.gen(function* () {
    const bots = yield* CrewService;
    const workflows = yield* WorkflowService;
    const execution = yield* WorkflowExecutionService;
    // Captain leads the manager's stage because it owns the project.
    yield* seedCrewProject({ projectId, title: "Execution", workspaceRoot: "/repo" });
    yield* bots.ensureDefaults(modelSelection);
    const managerId = (yield* bots.ensureProjectManager(projectId)).id;
    const roleId = "role:planner";
    const planner = yield* bots.createMember({
      id: `${featureId}-planner`,
      projectId,
      featureId,
      roleId,
      name: "Planner",
      instructions: "Plan",
      allowedTools: ["crew.respond", "crew.ask"],
      modelSelection,
      runtimeMode: "approval-required",
    });
    yield* bots.allowDelegation(managerId, planner.id);
    const captain = yield* bots.createRun({
      id: `${featureId}-captain`,
      memberId: "bot-captain",
      projectId,
      taskText: "Coordinate",
    });
    const manager = yield* bots.createRun({
      id: `${featureId}-manager`,
      memberId: managerId,
      projectId,
      taskText: "Supervise",
    });
    const definition: WorkflowDefinition = {
      schemaVersion: 2,
      id: featureId,
      name: "Delivery",
      revision: 1,
      start: "plan",
      roles: {
        manager: { roleId: PROJECT_MANAGER_ROLE_ID, roleRevision: 1, supervisor: null },
        planner: { roleId, roleRevision: 1, supervisor: "manager" },
      },
      steps: {
        plan: {
          type: "task",
          role: "planner",
          task: "Plan",
          next: { ready: "review", change: "decision" },
          outputs: ["plan.md"],
          ...(options.gate ? { gate: true } : {}),
        },
        decision: {
          type: "task",
          role: "manager",
          task: "Decide whether to revise",
          next: { revise: "plan", reject: "end" },
        },
        review: {
          type: "task",
          role: "manager",
          task: "Review",
          next: { approved: "end", revise: "plan" },
        },
        end: { type: "end" },
      },
      defaults: {
        questions: "supervisor",
        failure: "pause",
        maxStepExecutions: 6,
        retries: 0,
        ...(options.decisions ? { decisions: options.decisions } : {}),
      },
    };
    yield* workflows.createDefinition(definition);
    yield* workflows.copyForFeature(featureId, projectId, definition.id);
    const bindings = {
      manager: { memberId: managerId, dispatchRunId: captain.id },
      planner: { memberId: planner.id, dispatchRunId: manager.id },
    };
    return { featureId, definition, bindings, execution, workflows, bots, captain, manager };
  });

/** The active stage, its crew run, and the started event that names its stage record. */
const activeStage = (featureId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    const bots = yield* CrewService;
    const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
    const step = snapshot.steps.find((item) => item.id === snapshot.activeStepId)!;
    const run = (yield* bots.getRun(step.runId!))!.run;
    const start = snapshot.recentEvents.findLast(
      (event) => event.kind === "started" && event.runId === run.id,
    )!;
    return { snapshot, step, run, start, recordId: start.sourceId! };
  });

/** Ends the thread's open turns as its provider would, starting one when it has none. */
const endTurn = (threadId: ThreadId, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const { runs } = yield* (yield* OrchestratorV2).getThreadRecords(threadId, ["runs"]);
    const now = yield* DateTime.now;
    const open = runs.filter((run) => !isTerminalRunStatus(run.status));
    const turns =
      runs.length > 0
        ? open
        : [
            {
              id: RunId.make(`${threadId}:run`),
              threadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`${threadId}:start`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running" as const,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ];
    for (const run of turns) {
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make(`${run.id}:${status}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status, completedAt: now },
      });
    }
  });

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-execution-")),
    );
    return yield* use(directory).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

describe("Workflow execution", () => {
  it.effect("starts every stage from its persisted handoff record and nothing else", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO features (id, project_id, title, brief, created_at, updated_at, workspace)
          VALUES (${featureId}, ${projectId}, 'Kanban board', 'Add a board', '', '', 'worktree')`;
        const promptOf = (record: Parameters<typeof renderStageHandoff>[0]) => {
          const { taskText, contextText } = renderStageHandoff(record);
          return `Feature "Kanban board". ${taskText}\n\nContext:\n${contextText}`;
        };
        yield* execution.attach(featureId, projectId, bindings);

        const plan = yield* activeStage(featureId);
        const planRecord = (yield* workflows.getStageHandoffForThread(
          projectId,
          plan.run.threadId,
        ))!;
        // The record names the feature's worktree, made before the first stage's handoff.
        expect(planRecord).toMatchObject({
          id: plan.recordId,
          stepId: "plan",
          attempt: 1,
          from: null,
          produces: ["plan.md"],
          outputs: [],
          notes: [],
          retry: null,
          workspace: {
            cwd: `/worktrees/${system.worktrees[0]}`,
            branch: "crew/feature",
            commit: "0123456789abcdef0123",
          },
        });
        expect(plan.run.taskText).toBe(promptOf(planRecord));
        expect(
          yield* workflows.getStageHandoffForThread(ProjectId.make("other"), plan.run.threadId),
        ).toBeNull();

        system.files.add("plan.md");
        const planDiff = {
          turnCount: 2,
          fromRef: "refs/t3/plan/0",
          toRef: "refs/t3/plan/2",
          additions: 12,
          deletions: 3,
          fileCount: 2,
        };
        system.diffs.set(plan.run.threadId, planDiff);
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        yield* execution.reconcileFeature(featureId);

        const review = yield* activeStage(featureId);
        const reviewRecord = (yield* workflows.getStageHandoffForThread(
          projectId,
          review.run.threadId,
        ))!;
        expect(reviewRecord.from).toEqual({ stepId: "plan", outcome: "ready" });
        expect(reviewRecord.outputs).toEqual([
          {
            kind: "file",
            path: "plan.md",
            stepId: "plan",
            version: 1,
            threadId: plan.run.threadId,
            exists: true,
          },
          { kind: "diff", stepId: "plan", version: 1, threadId: plan.run.threadId, ...planDiff },
        ]);
        expect(reviewRecord.notes).toMatchObject([
          { stepId: "plan", kind: "routed", outcome: "ready", text: "Plan ready" },
        ]);
        expect(review.run.taskText).toBe(promptOf(reviewRecord));
        expect(review.run.taskText).toContain("plan.md v1, from plan");
        expect(review.run.taskText).toContain("git diff refs/t3/plan/0 refs/t3/plan/2");

        // Replays and restarts reuse the stored record instead of rebuilding it.
        system.files.delete("plan.md");
        const startsBefore = system.starts.length;
        yield* execution.reconcileFeature(featureId);
        yield* execution.reconcile();
        expect(system.starts.length).toBe(startsBefore);
        expect(yield* workflows.getStageHandoff(review.recordId)).toEqual(reviewRecord);

        // Rework sees the earlier version of its own output; the next stage sees the new one.
        yield* execution.report(review.run.threadId, "revise", "Split the plan into two phases");
        yield* execution.reconcileFeature(featureId);
        const rework = yield* activeStage(featureId);
        const reworkRecord = (yield* workflows.getStageHandoffForThread(
          projectId,
          rework.run.threadId,
        ))!;
        expect(reworkRecord.from).toEqual({ stepId: "review", outcome: "revise" });
        expect(reworkRecord.outputs).toMatchObject([
          { kind: "file", path: "plan.md", version: 1, exists: false },
          { kind: "diff", stepId: "plan", version: 1 },
        ]);
        expect(reworkRecord.notes.map((note) => note.text)).toEqual([
          "Split the plan into two phases",
        ]);
        yield* execution.report(rework.run.threadId, "ready", "Two phases");
        yield* execution.reconcileFeature(featureId);
        const secondReview = yield* activeStage(featureId);
        const secondReviewRecord = (yield* workflows.getStageHandoffForThread(
          projectId,
          secondReview.run.threadId,
        ))!;
        expect(secondReviewRecord.outputs).toMatchObject([
          { kind: "file", path: "plan.md", version: 2, threadId: rework.run.threadId },
        ]);
        expect((yield* workflows.getFeatureSnapshot(featureId, projectId))?.outputs).toEqual([
          {
            kind: "file",
            path: "plan.md",
            stepId: "plan",
            version: 2,
            threadId: rework.run.threadId,
          },
        ]);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("keeps a running feature on its workflow version when a new one is published", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, definition, execution, workflows, bindings } = yield* seed();
        yield* execution.attach(featureId, projectId, bindings);
        const review = definition.steps.review;
        if (review?.type !== "task") return yield* Effect.die("review is a task step");
        yield* workflows.reviseDefinition(
          {
            ...definition,
            revision: 2,
            steps: { ...definition.steps, review: { ...review, task: "Review with checklist" } },
          },
          1,
        );

        const plan = yield* activeStage(featureId);
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        yield* execution.reconcileFeature(featureId);
        const next = yield* activeStage(featureId);
        expect(next.snapshot.definition.revision).toBe(1);
        expect(
          (yield* workflows.getStageHandoffForThread(projectId, next.run.threadId))?.workflow,
        ).toEqual({ id: definition.id, name: definition.name, revision: 1 });
        expect(next.run.taskText.startsWith("Review\n")).toBe(true);

        const later = yield* workflows.copyForFeature("feature-later", projectId, definition.id);
        expect(later.definition.revision).toBe(2);
        expect(later.definition.steps.review).toMatchObject({ task: "Review with checklist" });
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("starts the next stage when the last stage's turn ends, without polling", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.scoped(
        Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          yield* execution.start();
          const changes = yield* (yield* WorkflowStore).subscribeChanges;
          const advanced = yield* changes.pipe(
            Stream.mapEffect(() => workflows.getFeatureState(featureId)),
            Stream.filter(
              (state) =>
                state?.activeStepId === "review" && state.steps.get("review")?.status === "running",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          const plan = yield* activeStage(featureId);
          const engine = yield* OrchestratorV2;
          // The planner is still in a turn when it reports.
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("planner-turn"),
            threadId: plan.run.threadId,
            messageId: MessageId.make("planner-turn"),
            text: "Plan",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            dispatchMode: { type: "queue_after_active" },
          });
          yield* execution.report(plan.run.threadId, "ready", "Plan ready");
          expect(system.starts.length).toBe(3);
          const shell = (yield* engine.getThreadShell(plan.run.threadId))!;
          yield* engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("planner-turn-ends"),
            threadId: plan.run.threadId,
            runId: shell.activeRunId!,
          });
          yield* Fiber.join(advanced);
          expect(system.starts.length).toBe(4);
        }),
      ).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect(
    "records answer, pause, resume, and cancel decisions and prevents duplicate or late work",
    () =>
      withDirectory((directory) => {
        const system = fixture(directory);
        return Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeStage(featureId);
          yield* execution.report(plan.run.threadId, "needs_input", "Which API?");
          yield* execution.reconcileFeature(featureId);
          const answer = {
            featureId,
            projectId,
            actorId: "person",
            requestId: "answer",
            kind: "answered" as const,
            text: "Current API",
          };
          yield* execution.control(answer);
          yield* execution.control(answer);
          expect((yield* workflows.getFeatureState(featureId))?.steps.get("plan")?.status).toBe(
            "running",
          );
          expect(
            (yield* execution.control({ ...answer, text: "Different API" }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          yield* execution.report(plan.run.threadId, "needs_input", "Which version?");
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.steps.get("plan")?.status).toBe(
            "needs-input",
          );
          yield* execution.control({ ...answer, requestId: "answer-2", text: "Latest" });
          // Each answer reaches the stage's own thread once.
          const { messages } = yield* (yield* OrchestratorV2).getThreadRecords(
            plan.run.threadId,
            ["messages"],
            { messageRoles: ["user"] },
          );
          expect(messages.map((message) => message.text)).toEqual([
            "Answer to your question: Current API",
            "Answer to your question: Latest",
          ]);
          yield* execution.control({ ...answer, kind: "paused", requestId: "pause" });
          yield* execution.report(plan.run.threadId, "ready", "Plan ready");
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.paused).toBe(true);
          expect(system.starts.length).toBe(3);
          yield* endTurn(plan.run.threadId, "completed");
          yield* execution.control({ ...answer, kind: "resumed", requestId: "resume" });
          expect(system.starts.length).toBe(4);
          const review = yield* activeStage(featureId);
          yield* execution.control({ ...answer, kind: "cancelled", requestId: "cancel" });
          yield* execution.control({ ...answer, kind: "cancelled", requestId: "cancel" });
          expect(system.interruptions).toEqual([review.run.threadId]);
          expect((yield* workflows.getFeatureState(featureId))?.cancelled).toBe(true);
          expect(
            (yield* execution.report(review.run.threadId, "approved", "Late").pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* workflows.getFeatureSnapshot(featureId, projectId))?.recentEvents
              .filter((event) => event.sourceKind === "decision")
              .map((event) => event.actorId),
          ).toEqual(["person", "person"]);
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect(
    "dispatches from verified receipts, keeps decision routing explicit, and deduplicates replay",
    () =>
      withDirectory((directory) => {
        const system = fixture(directory);
        return Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeStage(featureId);
          expect(plan.run.memberId).toBe(bindings.planner.memberId);
          expect(plan.start.actorId).toBe(bindings.planner.dispatchRunId);
          expect(plan.run.taskText).toContain("crew_respond");
          yield* execution.attach(featureId, projectId, bindings);
          yield* execution.reconcileFeature(featureId);
          expect(system.starts.length).toBe(3);
          yield* execution.report(plan.run.threadId, "change", "Design needs review");
          yield* execution.reconcileFeature(featureId);
          const decision = yield* activeStage(featureId);
          expect(decision.step.id).toBe("decision");
          expect(decision.run.memberId).toBe(bindings.manager.memberId);
          yield* execution.report(decision.run.threadId, "revise", "Revise the plan");
          yield* execution.reconcileFeature(featureId);
          const rework = yield* activeStage(featureId);
          expect(rework.step.executionId).not.toBe(plan.step.executionId);
          expect(rework.step.attempt).toBe(1);
          yield* execution.report(rework.run.threadId, "ready", "Revised plan");
          yield* execution.reconcileFeature(featureId);
          const review = yield* activeStage(featureId);
          yield* execution.report(review.run.threadId, "approved", "Reviewed");
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.completed).toBe(true);
          yield* execution.reconcile();
          expect(system.starts.length).toBe(6);
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect("records a repeated report once, as crew_respond is idempotent", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        yield* execution.attach(featureId, projectId, bindings);
        const plan = yield* activeStage(featureId);
        yield* execution.report(plan.run.threadId, "needs_input", "Which API?");
        yield* execution.report(plan.run.threadId, "needs_input", "Which API?");
        yield* execution.control({
          featureId,
          projectId,
          actorId: "person",
          requestId: "answer",
          kind: "answered",
          text: "Current API",
        });
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        expect(yield* execution.report(plan.run.threadId, "ready", "Plan ready")).toEqual({
          stepId: "plan",
          recorded: "completed",
        });
        const kinds = () =>
          workflows
            .getFeatureSnapshot(featureId, projectId)
            .pipe(Effect.map((snapshot) => snapshot!.recentEvents.map((event) => event.kind)));
        // Review shares the worktree, so it starts once the planner's turn has ended.
        expect(yield* kinds()).toEqual(["started", "question", "answered", "completed"]);
        yield* endTurn(plan.run.threadId, "completed");
        yield* execution.reconcileFeature(featureId);
        expect(yield* kinds()).toEqual(["started", "question", "answered", "completed", "started"]);
        const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
        expect(snapshot.recentEvents[1]?.detail).toBe("Which API?");
        expect(snapshot.recentEvents[2]?.detail).toBe("Current API");
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect(
    "refuses unrouted outcomes, reminds a silent stage once, then fails and retries it fresh",
    () =>
      withDirectory((directory) => {
        const system = fixture(directory);
        return Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const first = yield* activeStage(featureId);
          const planStatus = () =>
            workflows
              .getFeatureState(featureId)
              .pipe(Effect.map((state) => state?.steps.get("plan")?.status));
          // The agent can correct an outcome its stage doesn't route.
          const unknown = yield* Effect.flip(
            execution.report(first.run.threadId, "unknown", "Done"),
          );
          expect(unknown.message).toContain("Report one of: ready, change, needs_input");
          expect(yield* planStatus()).toBe("running");

          yield* endTurn(first.run.threadId, "completed");
          yield* execution.reconcileFeature(featureId);
          expect(yield* planStatus()).toBe("running");
          const { messages } = yield* (yield* OrchestratorV2).getThreadRecords(
            first.run.threadId,
            ["messages"],
            { messageRoles: ["user"] },
          );
          expect(messages.map((message) => message.text)).toEqual([
            expect.stringContaining("This stage has no result yet"),
          ]);
          yield* endTurn(first.run.threadId, "completed");
          yield* execution.reconcileFeature(featureId);
          expect(yield* planStatus()).toBe("failed");
          yield* workflows.recordTrustedEvent(featureId, {
            id: "retry",
            stepId: "plan",
            executionId: first.step.executionId,
            kind: "retry",
            runId: null,
            outcome: null,
            sourceKind: null,
            sourceId: null,
            actorId: "person",
            detail: null,
            occurredAt: "2026-09-30T00:00:00Z",
          });
          yield* execution.reconcileFeature(featureId);
          const second = yield* activeStage(featureId);
          expect(second.run.id).not.toBe(first.run.id);
          expect(second.recordId).not.toBe(first.recordId);
          expect(second.step.executionId).toBe(first.step.executionId);
          expect(second.step.attempt).toBe(2);
          expect(
            (yield* workflows.getStageHandoffForThread(projectId, second.run.threadId))?.retry,
          ).toEqual({
            previousError: "The stage ended without reporting a result with crew_respond",
          });
          expect(second.run.taskText).toContain("The previous attempt failed:");
          yield* endTurn(second.run.threadId, "failed");
          yield* execution.reconcileFeature(featureId);
          expect(yield* planStatus()).toBe("failed");
          // A person's Retry is never capped; only automatic retries are.
          expect(
            (yield* workflows
              .recordTrustedEvent(featureId, {
                id: "retry-again",
                stepId: "plan",
                executionId: second.step.executionId,
                kind: "retry",
                runId: null,
                outcome: null,
                sourceKind: null,
                sourceId: null,
                actorId: "person",
                detail: null,
                occurredAt: "2026-09-30T00:00:01Z",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Success");
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect("keeps a stage a restart cut running until it continues, then completes it", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        const engine = yield* OrchestratorV2;
        yield* execution.attach(featureId, projectId, bindings);
        const plan = yield* activeStage(featureId);
        const planStatus = () =>
          workflows
            .getFeatureState(featureId)
            .pipe(Effect.map((state) => state?.steps.get("plan")?.status));
        const prompts = () =>
          engine
            .getThreadRecords(plan.run.threadId, ["messages"], { messageRoles: ["user"] })
            .pipe(Effect.map(({ messages }) => messages.map((message) => message.text)));
        // Startup recovery cancels the running turn and queues the server's own continuation.
        yield* endTurn(plan.run.threadId, "cancelled");
        const [cut] = (yield* engine.getThreadRecords(plan.run.threadId, ["runs"])).runs;
        yield* (yield* EffectOutbox.EffectOutboxV2).enqueue([
          {
            id: `effect:restart-continuation:${cut!.id}`,
            commandId: CommandId.make("restart"),
            threadId: plan.run.threadId,
            request: { type: "provider-runtime.continue", sourceRunId: cut!.id },
          },
        ]);
        yield* execution.reconcileFeature(featureId);
        expect(yield* planStatus()).toBe("running");
        expect(yield* prompts()).toEqual([]);

        // The server continues the turn itself, so the stage keeps waiting on that turn.
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        yield* execution.reconcileFeature(featureId);
        expect(yield* planStatus()).toBe("running");
        expect(yield* prompts()).toEqual(["Continue where you left off."]);

        // A cut with no continuation coming is continued by the workflow, once.
        yield* endTurn(plan.run.threadId, "cancelled");
        yield* execution.reconcileFeature(featureId);
        yield* execution.reconcileFeature(featureId);
        expect(yield* planStatus()).toBe("running");
        expect((yield* prompts()).toSorted()).toEqual([
          "Continue where you left off.",
          expect.stringContaining("The server restarted while this stage was working"),
        ]);

        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        yield* endTurn(plan.run.threadId, "completed");
        yield* execution.reconcileFeature(featureId);
        expect((yield* activeStage(featureId)).step.id).toBe("review");
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("turns failed dispatch into a visible retryable attempt", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        system.failNextDispatch();
        yield* execution.attach(featureId, projectId, bindings);
        const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
        expect(snapshot.steps.find((step) => step.id === "plan")?.status).toBe("failed");
        expect(snapshot.recentEvents.at(-1)?.detail).toContain("dispatch failed");
        yield* execution.reconcile();
        expect(system.starts.length).toBe(2);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("rejects mismatched instances and missing grants without starting work", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings, bots } = yield* seed();
        expect(
          (yield* execution
            .attach(featureId, projectId, {
              ...bindings,
              planner: { ...bindings.planner, memberId: bindings.manager.memberId },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* bots.revokeDelegation(bindings.manager.memberId, bindings.planner.memberId);
        expect(
          (yield* execution.attach(featureId, projectId, bindings).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* workflows.getFeatureState(featureId))?.executionCount).toBe(0);
        expect(system.starts.length).toBe(2);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("recovers a recorded completion after restart without rerunning settled work", () =>
    withDirectory((directory) => {
      const first = fixture(directory);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { featureId, execution, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeStage(featureId);
          yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecutionService;
          yield* execution.reconcile();
          // The report started the next stage before the restart.
          expect(restarted.starts.length).toBe(0);
          const review = yield* activeStage("feature-one");
          expect(review.step.id).toBe("review");
          yield* execution.report(review.run.threadId, "approved", "Reviewed");
          yield* execution.reconcile();
          expect((yield* (yield* WorkflowService).getFeatureState("feature-one"))?.completed).toBe(
            true,
          );
        }).pipe(Effect.provide(restarted.layer));
        const settled = fixture(directory);
        yield* Effect.gen(function* () {
          yield* (yield* WorkflowExecutionService).reconcile();
        }).pipe(Effect.provide(settled.layer));
        expect(settled.starts.length).toBe(0);
      });
    }),
  );

  it.effect("replays an answer intent saved before delivery after restart", () =>
    withDirectory((directory) => {
      const first = fixture(directory);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeStage(featureId);
          yield* execution.report(plan.run.threadId, "needs_input", "Which API?");
          yield* execution.reconcileFeature(featureId);
          yield* workflows.recordTrustedEvent(featureId, {
            id: "saved-answer",
            stepId: "plan",
            executionId: plan.step.executionId,
            kind: "answered",
            runId: null,
            outcome: null,
            sourceKind: "decision",
            sourceId: plan.recordId,
            actorId: "person",
            detail: "Current API",
            occurredAt: "2026-09-30T00:00:00Z",
          });
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecutionService;
          yield* execution.reconcile();
          yield* execution.reconcile();
          const plan = yield* activeStage("feature-one");
          const { messages } = yield* (yield* OrchestratorV2).getThreadRecords(
            plan.run.threadId,
            ["messages"],
            { messageRoles: ["user"] },
          );
          expect(messages.map((message) => message.text)).toEqual([
            "Answer to your question: Current API",
          ]);
          yield* execution.report(plan.run.threadId, "needs_input", "Which version?");
          yield* execution.reconcile();
          expect(
            (yield* (yield* WorkflowService).getFeatureState("feature-one"))?.steps.get("plan")
              ?.status,
          ).toBe("needs-input");
          expect(restarted.starts).toEqual([]);
        }).pipe(Effect.provide(restarted.layer));
      });
    }),
  );

  it.effect("replays a cancellation whose interrupt failed before restart", () =>
    withDirectory((directory) => {
      const first = fixture(directory);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          first.failNextInterrupt();
          expect(
            (yield* execution
              .control({
                featureId,
                projectId,
                requestId: "cancel",
                actorId: "person",
                kind: "cancelled",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* workflows.getFeatureState(featureId))?.cancelled).toBe(true);
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecutionService;
          yield* execution.reconcile();
          yield* execution.reconcile();
        }).pipe(Effect.provide(restarted.layer));
        expect(restarted.interruptions.length).toBe(1);
        expect(restarted.starts).toEqual([]);
      });
    }),
  );

  it.effect("labels each stage thread with its feature stage and keeps one current", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const engine = yield* OrchestratorV2;
        const sql = yield* SqlClient.SqlClient;
        const { featureId, execution, bindings } = yield* seed();
        yield* sql`INSERT INTO features (id, project_id, title, brief, created_at, updated_at, workspace)
          VALUES (${featureId}, ${projectId}, 'Kanban board', 'Add a board', '', '', 'worktree')`;
        yield* execution.attach(featureId, projectId, bindings);
        const plan = yield* activeStage(featureId);
        const planShell = (yield* engine.getThreadShell(plan.run.threadId))!;
        expect(planShell.title).toBe("Kanban board");
        expect(planShell.crew).toEqual({
          featureId,
          stepId: "plan",
          index: 1,
          total: 3,
          state: "working",
          current: true,
          revision: expect.any(Number),
        });

        // A person's rename survives later stage updates.
        yield* engine.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename"),
          threadId: plan.run.threadId,
          title: "My plan",
        });
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        yield* execution.reconcileFeature(featureId);
        const review = yield* activeStage(featureId);
        // Both stages open in the one worktree the feature made from the checkout's branch.
        expect(system.worktrees).toEqual([
          expect.stringMatching(/^bosun\/kanban-board-[0-9a-f]{6}$/),
        ]);
        const featureWorkspace = {
          branch: system.worktrees[0],
          worktreePath: `/worktrees/${system.worktrees[0]}`,
        };
        expect(system.starts.find((start) => start.runId === plan.run.id)?.workspace).toEqual(
          featureWorkspace,
        );
        expect(system.starts.find((start) => start.runId === review.run.id)?.workspace).toEqual(
          featureWorkspace,
        );
        expect((yield* engine.getThreadShell(review.run.threadId))?.crew).toMatchObject({
          stepId: "review",
          index: 3,
          current: true,
        });
        const earlier = (yield* engine.getThreadShell(plan.run.threadId))!;
        expect(earlier.title).toBe("My plan");
        expect(earlier.crew).toMatchObject({ stepId: "plan", current: false, state: "working" });

        yield* execution.control({
          featureId,
          projectId,
          requestId: "cancel",
          actorId: "person",
          kind: "cancelled",
        });
        expect((yield* engine.getThreadShell(review.run.threadId))?.crew?.state).toBe("cancelled");
        // The earlier thread kept the summary it handed on with.
        expect((yield* engine.getThreadShell(plan.run.threadId))?.crew?.state).toBe("working");

        // A summary write lost after the feature settled is repaired by the next reconcile.
        yield* sql`UPDATE crew_stage_threads
          SET summary_json = json_set(summary_json, '$.state', 'working')
          WHERE thread_id = ${review.run.threadId}`;
        yield* execution.reconcile();
        const repaired = yield* sql<{ readonly state: string }>`
          SELECT json_extract(summary_json, '$.state') AS state FROM crew_stage_threads
          WHERE thread_id = ${review.run.threadId}`;
        expect(repaired[0]?.state).toBe("cancelled");
      }).pipe(Effect.provide(system.layer));
    }),
  );
  it.effect("lets the lead answer and decide gates on a workflow whose lead decides", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings, manager } = yield* seed("feature-one", {
          decisions: "lead",
          gate: true,
        });
        const engine = yield* OrchestratorV2;
        const prompts = (threadId: ThreadId) =>
          engine
            .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
            .pipe(Effect.map(({ messages }) => messages.map((message) => message.text)));
        const planStatus = () =>
          workflows
            .getFeatureState(featureId)
            .pipe(Effect.map((state) => state?.steps.get("plan")?.status));
        const decide = (decision: "approve" | "request_changes" | "answer", text?: string) =>
          execution.decide({ threadId: manager.threadId, decision, ...(text ? { text } : {}) });
        yield* execution.attach(featureId, projectId, bindings);
        const plan = yield* activeStage(featureId);
        const leadPrompts = (yield* prompts(manager.threadId)).length;

        // A question goes to the lead once, and its answer to the stage's thread.
        yield* execution.report(plan.run.threadId, "needs_input", "Which API?");
        yield* execution.reconcileFeature(featureId);
        const asked = (yield* prompts(manager.threadId)).slice(leadPrompts);
        expect(asked).toEqual([expect.stringContaining("Which API?")]);
        expect((yield* Effect.flip(decide("answer"))).message).toContain("answer as text");
        yield* decide("answer", "Use v2");
        expect(yield* planStatus()).toBe("running");
        expect(yield* prompts(plan.run.threadId)).toEqual(["Answer to your question: Use v2"]);

        // A gate goes to the lead once too, however often the feature reconciles.
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        yield* execution.reconcileFeature(featureId);
        yield* execution.reconcile();
        const gated = (yield* prompts(manager.threadId)).slice(leadPrompts + 1);
        expect(gated).toEqual([expect.stringContaining("Plan ready")]);
        expect((yield* Effect.flip(decide("request_changes"))).message).toContain("what to change");
        yield* decide("approve");
        expect(yield* planStatus()).toBe("completed");
        const approved = (yield* workflows.getFeatureSnapshot(
          featureId,
          projectId,
        ))!.recentEvents.find((event) => event.kind === "approved");
        expect(approved?.actorId).toBe(manager.id);
        expect((yield* Effect.flip(decide("approve"))).message).toContain("waiting at its gate");
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("leaves the gate to a person who decides first, and to people on other workflows", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const lead = yield* seed("feature-one", { decisions: "lead", gate: true });
        const person = yield* seed("feature-two", { gate: true });
        const { execution, workflows, manager } = lead;
        yield* execution.attach(lead.featureId, projectId, lead.bindings);
        yield* execution.attach(person.featureId, projectId, person.bindings);
        const decide = (threadId: ThreadId, featureId: string) =>
          execution.decide({ threadId, featureId, decision: "approve" }).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

        // Nothing waits while the stage works; a thread that doesn't lead it never decides.
        expect(yield* decide(manager.threadId, lead.featureId)).toContain("waiting at its gate");
        const plan = yield* activeStage(lead.featureId);
        expect(yield* decide(plan.run.threadId, lead.featureId)).toContain("doesn't lead");
        yield* execution.report(plan.run.threadId, "ready", "Plan ready");
        const other = yield* activeStage(person.featureId);
        yield* execution.report(other.run.threadId, "ready", "Plan ready");
        expect(yield* decide(person.manager.threadId, person.featureId)).toContain(
          "A person decides",
        );

        yield* execution.control({
          featureId: lead.featureId,
          projectId,
          requestId: "person-approves",
          actorId: "person",
          kind: "approved",
        });
        expect((yield* workflows.getFeatureState(lead.featureId))?.steps.get("plan")?.status).toBe(
          "completed",
        );
        expect(yield* decide(manager.threadId, lead.featureId)).toContain("waiting at its gate");
      }).pipe(Effect.provide(system.layer));
    }),
  );
});
