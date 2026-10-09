// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { BotService, BotServiceLive } from "../bots/BotService.ts";
import { BotStoreLive } from "../bots/BotStore.ts";
import { BotThreadRuntime, type BotThreadStart } from "../bots/BotThreadRuntime.ts";
import { BotHandoffService, BotHandoffServiceLive } from "../bots/BotHandoffService.ts";
import { BotHandoffStore, BotHandoffStoreLive } from "../bots/BotHandoffStore.ts";
import { ServerConfig } from "../config.ts";
import { BotTestOrchestration as OrchestrationLayerLive } from "../bots/BotRuntime.testkit.ts";
import { OrchestratorDispatchError as OrchestrationCommandInvariantError } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { WorkflowService, WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowStore, WorkflowStoreLive } from "./WorkflowStore.ts";
import { WorkflowExecutionStoreLive } from "./WorkflowExecutionStore.ts";
import {
  WorkflowExecutionService,
  WorkflowExecutionServiceLive,
} from "./WorkflowExecutionService.ts";

const projectId = ProjectId.make("execution-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

const fixture = (directory: string) => {
  const starts: Array<BotThreadStart> = [];
  const interruptions: Array<string> = [];
  let failDispatch = false;
  let failInterrupt = false;
  let duringDispatch: ((input: BotThreadStart) => Effect.Effect<void>) | null = null;
  const runtime = Layer.succeed(
    BotThreadRuntime,
    BotThreadRuntime.of({
      projectExists: () => Effect.succeed(true),
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
          if (duringDispatch) yield* duringDispatch(input);
        }),
      replayPending: () => Effect.void,
      notify: () => Effect.void,
      interrupt: (threadId) =>
        Effect.gen(function* () {
          if (failInterrupt) {
            failInterrupt = false;
            return yield* new OrchestrationCommandInvariantError({
              commandId: CommandId.make("test"),
              commandType: "message.dispatch",
              cause: "Interrupt unavailable",
            });
          }
          interruptions.push(threadId);
        }),
      listPendingStartedRunIds: () => Effect.succeed([]),
      getTurnState: () => Effect.succeed("running"),
    }),
  );
  const foundation = BotServiceLive.pipe(
    Layer.provideMerge(BotStoreLive),
    Layer.provideMerge(runtime),
  );
  const bots = BotHandoffServiceLive.pipe(
    Layer.provideMerge(BotHandoffStoreLive),
    Layer.provideMerge(foundation),
  );
  const workflows = WorkflowServiceLive.pipe(
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(bots),
  );
  const execution = WorkflowExecutionServiceLive.pipe(
    Layer.provideMerge(WorkflowExecutionStoreLive),
    Layer.provideMerge(workflows),
  );
  const layer = execution.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "workflow-execution-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    starts,
    interruptions,
    failNextDispatch: () => {
      failDispatch = true;
    },
    failNextInterrupt: () => {
      failInterrupt = true;
    },
    onDispatch: (callback: (input: BotThreadStart) => Effect.Effect<void>) => {
      duringDispatch = callback;
    },
  };
};

const seed = (featureId = "feature-one") =>
  Effect.gen(function* () {
    const bots = yield* BotService;
    const workflows = yield* WorkflowService;
    const execution = yield* WorkflowExecutionService;
    yield* bots.ensureCrew(projectId, modelSelection);
    const templateId = `template:planner:${projectId}`;
    const planner = yield* bots.createDefinition({
      id: `${featureId}-planner`,
      projectId,
      featureId,
      templateId,
      name: "Planner",
      instructions: "Plan",
      allowedTools: ["bots.respond", "bots.ask"],
      modelSelection,
      runtimeMode: "approval-required",
    });
    const managerId = `bot-manager:${projectId}`;
    yield* bots.allowDelegation(managerId, planner.id);
    const captain = yield* bots.createRun({
      id: `${featureId}-captain`,
      botId: "bot-captain",
      projectId,
      taskText: "Coordinate",
    });
    const manager = yield* bots.createRun({
      id: `${featureId}-manager`,
      botId: managerId,
      projectId,
      taskText: "Supervise",
    });
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: featureId,
      name: "Delivery",
      revision: 1,
      start: "plan",
      bots: {
        manager: { template: { kind: "existing-project-bot", id: managerId }, supervisor: null },
        planner: {
          template: { kind: "template", id: templateId, revision: 1 },
          supervisor: "manager",
        },
      },
      steps: {
        plan: {
          type: "task",
          bot: "planner",
          task: "Plan",
          next: { ready: "review", change: "decision" },
        },
        decision: {
          type: "task",
          bot: "manager",
          task: "Decide whether to revise",
          next: { revise: "plan", reject: "end" },
        },
        review: {
          type: "task",
          bot: "manager",
          task: "Review",
          next: { approved: "end", revise: "plan" },
        },
        end: { type: "end" },
      },
      defaults: {
        questions: "supervisor",
        failure: "pause",
        maxAttemptsPerExecution: 2,
        maxStepExecutions: 6,
      },
    };
    yield* workflows.createDefinition(projectId, definition);
    yield* workflows.copyForFeature(featureId, projectId, definition.id);
    const bindings = {
      manager: { botId: managerId, dispatchRunId: captain.id },
      planner: { botId: planner.id, dispatchRunId: manager.id },
    };
    return { featureId, definition, bindings, execution, workflows, bots };
  });

const activeHandoff = (featureId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    const bots = yield* BotService;
    const handoffs = yield* BotHandoffStore;
    const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
    const step = snapshot.steps.find((item) => item.id === snapshot.activeStepId)!;
    const run = (yield* bots.getRun(step.botRunId!))!.run;
    const handoff = (yield* handoffs.getForTargetRun(run.id))!;
    return { snapshot, step, run, handoff };
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
  it.effect("advances from the live receipt subscription without polling", () =>
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
          const plan = yield* activeHandoff(featureId);
          yield* (yield* BotHandoffService).respond(
            plan.run.threadId,
            "completed",
            '{"outcome":"ready","summary":"Plan ready"}',
          );
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
          const handoffs = yield* BotHandoffService;
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeHandoff(featureId);
          yield* handoffs.ask(plan.run.threadId, "Which API?");
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
          yield* handoffs.ask(plan.run.threadId, "Which version?");
          yield* execution.reconcileFeature(featureId);
          expect((yield* handoffs.get(plan.handoff.id))?.status).toBe("needs-input");
          yield* execution.control({ ...answer, requestId: "answer-2", text: "Latest" });
          yield* execution.control({ ...answer, kind: "paused", requestId: "pause" });
          yield* handoffs.respond(
            plan.run.threadId,
            "completed",
            '{"outcome":"ready","summary":"Plan ready"}',
          );
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.paused).toBe(true);
          expect(system.starts.length).toBe(3);
          yield* execution.control({ ...answer, kind: "resumed", requestId: "resume" });
          expect(system.starts.length).toBe(4);
          const review = yield* activeHandoff(featureId);
          yield* execution.control({ ...answer, kind: "cancelled", requestId: "cancel" });
          yield* execution.control({ ...answer, kind: "cancelled", requestId: "cancel" });
          expect(system.interruptions).toEqual([review.run.threadId]);
          expect((yield* workflows.getFeatureState(featureId))?.cancelled).toBe(true);
          expect(
            (yield* handoffs
              .respond(review.run.threadId, "completed", '{"outcome":"approved","summary":"Late"}')
              .pipe(Effect.result))._tag,
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
          const handoffs = yield* BotHandoffService;
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeHandoff(featureId);
          expect(plan.run.botId).toBe(bindings.planner.botId);
          expect(plan.handoff.sourceRunId).toBe(bindings.planner.dispatchRunId);
          expect(plan.run.taskText).toContain("bots_respond");
          yield* execution.attach(featureId, projectId, bindings);
          yield* execution.reconcileFeature(featureId);
          expect(system.starts.length).toBe(3);
          yield* handoffs.respond(
            plan.run.threadId,
            "completed",
            '{"outcome":"change","summary":"Design needs review"}',
          );
          yield* execution.reconcileFeature(featureId);
          const decision = yield* activeHandoff(featureId);
          expect(decision.step.id).toBe("decision");
          expect(decision.run.botId).toBe(bindings.manager.botId);
          yield* handoffs.respond(
            decision.run.threadId,
            "completed",
            '{"outcome":"revise","summary":"Revise the plan"}',
          );
          yield* execution.reconcileFeature(featureId);
          const rework = yield* activeHandoff(featureId);
          expect(rework.step.executionId).not.toBe(plan.step.executionId);
          expect(rework.step.attempt).toBe(1);
          yield* handoffs.respond(
            rework.run.threadId,
            "completed",
            '{"outcome":"ready","summary":"Revised plan"}',
          );
          yield* execution.reconcileFeature(featureId);
          const review = yield* activeHandoff(featureId);
          yield* handoffs.respond(
            review.run.threadId,
            "completed",
            '{"outcome":"approved","summary":"Reviewed"}',
          );
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.completed).toBe(true);
          yield* execution.reconcile();
          expect(system.starts.length).toBe(6);
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect("retains questions and answers that settle before reconciliation", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        const handoffs = yield* BotHandoffService;
        yield* execution.attach(featureId, projectId, bindings);
        const plan = yield* activeHandoff(featureId);
        yield* handoffs.ask(plan.run.threadId, "Which API?");
        yield* handoffs.answerFromBot(
          (yield* (yield* BotService).getRun(bindings.planner.dispatchRunId))!.run.threadId,
          plan.handoff.id,
          "Current API",
        );
        yield* handoffs.respond(
          plan.run.threadId,
          "completed",
          '{"outcome":"ready","summary":"Plan ready"}',
        );
        yield* execution.reconcileFeature(featureId);
        const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
        expect(snapshot.recentEvents.map((event) => event.kind)).toEqual([
          "started",
          "question",
          "answered",
          "completed",
          "started",
        ]);
        expect(snapshot.recentEvents[1]?.detail).toBe("Which API?");
        expect(snapshot.recentEvents[2]?.detail).toBe("Current API");
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect(
    "pauses on invalid outcomes and retries with a fresh run without losing prior evidence",
    () =>
      withDirectory((directory) => {
        const system = fixture(directory);
        return Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          const handoffs = yield* BotHandoffService;
          yield* execution.attach(featureId, projectId, bindings);
          const first = yield* activeHandoff(featureId);
          yield* handoffs.respond(
            first.run.threadId,
            "completed",
            '{"outcome":"unknown","summary":"Done"}',
          );
          yield* execution.reconcileFeature(featureId);
          expect((yield* workflows.getFeatureState(featureId))?.steps.get("plan")?.status).toBe(
            "failed",
          );
          yield* workflows.recordTrustedEvent(featureId, {
            id: "retry",
            stepId: "plan",
            executionId: first.step.executionId,
            kind: "retry",
            botRunId: null,
            outcome: null,
            sourceKind: null,
            sourceId: null,
            actorId: "person",
            detail: null,
            occurredAt: "2026-09-30T00:00:00Z",
          });
          yield* execution.reconcileFeature(featureId);
          const second = yield* activeHandoff(featureId);
          expect(second.run.id).not.toBe(first.run.id);
          expect(second.handoff.id).not.toBe(first.handoff.id);
          expect(second.step.executionId).toBe(first.step.executionId);
          expect(second.step.attempt).toBe(2);
          expect((yield* (yield* BotHandoffStore).get(first.handoff.id))?.responseText).toContain(
            "unknown",
          );
          yield* handoffs.respond(second.run.threadId, "failed", "Provider unavailable");
          yield* execution.reconcileFeature(featureId);
          // A person's Retry is never capped; only automatic retries are.
          expect(
            (yield* workflows
              .recordTrustedEvent(featureId, {
                id: "retry-again",
                stepId: "plan",
                executionId: second.step.executionId,
                kind: "retry",
                botRunId: null,
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
              planner: { ...bindings.planner, botId: bindings.manager.botId },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* bots.revokeDelegation(bindings.manager.botId, bindings.planner.botId);
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
          const plan = yield* activeHandoff(featureId);
          yield* (yield* BotHandoffService).respond(
            plan.run.threadId,
            "completed",
            '{"outcome":"ready","summary":"Plan ready"}',
          );
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecutionService;
          yield* execution.reconcile();
          expect(restarted.starts.length).toBe(1);
          const review = yield* activeHandoff("feature-one");
          expect(review.step.id).toBe("review");
          yield* (yield* BotHandoffService).respond(
            review.run.threadId,
            "completed",
            '{"outcome":"approved","summary":"Reviewed"}',
          );
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

  it.effect("retains a handoff cancelled before its start was recorded", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { featureId, execution, workflows, bindings } = yield* seed();
        const handoffs = yield* BotHandoffService;
        const store = yield* BotHandoffStore;
        system.onDispatch((input) =>
          Effect.gen(function* () {
            const handoff = yield* store.getForTargetRun(input.runId);
            if (handoff) yield* handoffs.cancel(handoff.id);
          }).pipe(Effect.orDie),
        );
        yield* execution.attach(featureId, projectId, bindings);
        const snapshot = (yield* workflows.getFeatureSnapshot(featureId, projectId))!;
        expect(snapshot.cancelled).toBe(true);
        expect(snapshot.recentEvents.map((event) => event.kind)).toEqual(["started", "cancelled"]);
        expect(snapshot.steps.find((step) => step.id === "plan")?.botRunId).not.toBeNull();
        yield* execution.reconcile();
        expect(system.starts.length).toBe(3);
        expect(system.interruptions.length).toBe(1);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("replays an answer intent saved before delivery after restart", () =>
    withDirectory((directory) => {
      const first = fixture(directory);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { featureId, execution, workflows, bindings } = yield* seed();
          yield* execution.attach(featureId, projectId, bindings);
          const plan = yield* activeHandoff(featureId);
          yield* (yield* BotHandoffService).ask(plan.run.threadId, "Which API?");
          yield* execution.reconcileFeature(featureId);
          yield* workflows.recordTrustedEvent(featureId, {
            id: "saved-answer",
            stepId: "plan",
            executionId: plan.step.executionId,
            kind: "answered",
            botRunId: null,
            outcome: null,
            sourceKind: "decision",
            sourceId: plan.handoff.id,
            actorId: "person",
            detail: "Current API",
            occurredAt: "2026-09-30T00:00:00Z",
          });
          expect((yield* (yield* BotHandoffStore).get(plan.handoff.id))?.status).toBe(
            "needs-input",
          );
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecutionService;
          yield* execution.reconcile();
          const plan = yield* activeHandoff("feature-one");
          expect(plan.handoff.status).toBe("running");
          expect(plan.handoff.responseText).toBe("Current API");
          yield* (yield* BotHandoffService).ask(plan.run.threadId, "Which version?");
          yield* execution.reconcile();
          expect((yield* (yield* BotHandoffStore).get(plan.handoff.id))?.status).toBe(
            "needs-input",
          );
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
          expect((yield* (yield* BotHandoffStore).listRunning()).length).toBe(0);
        }).pipe(Effect.provide(restarted.layer));
        expect(restarted.interruptions.length).toBe(1);
        expect(restarted.starts).toEqual([]);
      });
    }),
  );
});
