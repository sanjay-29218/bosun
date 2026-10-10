// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type WorkflowDefinition,
  type WorkflowStepEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { BotService } from "../bots/BotService.ts";
import { BotHandoffStore } from "../bots/BotHandoffStore.ts";
import { BotRuntimeLive } from "../bots/runtimeLayer.ts";
import { ServerConfig } from "../config.ts";
import {
  BotTestOrchestration as OrchestrationLayerLive,
  seedBotProject,
} from "../bots/BotRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { WorkflowService, WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowStore, WorkflowStoreLive } from "./WorkflowStore.ts";
import { WorkflowStageHandoffStoreLive } from "./WorkflowStageHandoffStore.ts";
import { WorkflowWorkspaceEmpty } from "./WorkflowWorkspace.ts";

const projectId = ProjectId.make("workflow-service-project");
const otherProjectId = ProjectId.make("workflow-service-other");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const templateId = `template:planner:${projectId}`;

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "plan",
  bots: {
    manager: {
      template: { kind: "existing-project-bot", id: `bot-manager:${projectId}` },
      supervisor: null,
    },
    planner: { template: { kind: "template", id: templateId, revision: 1 }, supervisor: "manager" },
  },
  steps: {
    plan: { type: "task", bot: "planner", task: "Plan", next: { ready: "end" } },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 3,
    maxStepExecutions: 30,
  },
};

const stepEvent = (
  id: string,
  kind: WorkflowStepEvent["kind"],
  fields: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent => ({
  id,
  stepId: "plan",
  kind,
  executionId: null,
  botRunId: null,
  outcome: null,
  sourceKind: null,
  sourceId: null,
  actorId: "manager",
  detail: null,
  occurredAt: "2026-09-29T00:00:00.000Z",
  ...fields,
});

const createProject = (engine: OrchestrationEngineService["Service"], id: ProjectId) =>
  seedBotProject({
    projectId: id,
    title: `Test ${id}`,
    workspaceRoot: `/tmp/${id}`,
  });

describe("Workflow service", () => {
  effectIt.effect("validates template ownership and keeps feature copies on their revision", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-service-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const orchestration = OrchestrationLayerLive;
      const bots = BotRuntimeLive.pipe(Layer.provide(orchestration));
      const workflows = WorkflowServiceLive.pipe(
        Layer.provideMerge(WorkflowStoreLive),
        Layer.provideMerge(WorkflowStageHandoffStoreLive),
        Layer.provideMerge(WorkflowWorkspaceEmpty),
        Layer.provideMerge(bots),
      );
      const layer = Layer.mergeAll(orchestration, workflows).pipe(
        Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "workflow-test-" })),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const exercise = Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const botService = yield* BotService;
        const handoffs = yield* BotHandoffStore;
        const workflow = yield* WorkflowService;
        yield* createProject(engine, projectId);
        yield* createProject(engine, otherProjectId);
        yield* botService.ensureCrew(projectId, modelSelection);

        const starter = yield* workflow.ensureStarterDefinition(projectId);
        expect(Object.keys(starter.steps)).toEqual([
          "plan",
          "design",
          "build",
          "qa",
          "review",
          "change_review",
          "end",
        ]);
        expect(yield* workflow.ensureStarterDefinition(projectId)).toEqual(starter);

        const researcher = yield* botService.createTemplate({
          id: "template:researcher",
          projectId,
          name: "Researcher",
          instructions: "Investigate the feature",
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        yield* workflow.validateDefinition(projectId, {
          ...definition,
          bots: {
            manager: definition.bots.manager!,
            researcher: {
              template: { kind: "template", id: researcher.id, revision: researcher.revision },
              supervisor: "manager",
            },
          },
          steps: {
            plan: { type: "task", bot: "researcher", task: "Investigate", next: { ready: "end" } },
            end: { type: "end" },
          },
        });

        expect(
          (yield* workflow
            .validateDefinition(projectId, {
              ...definition,
              bots: {
                ...definition.bots,
                planner: {
                  template: { kind: "template", id: templateId, revision: 99 },
                  supervisor: "manager",
                },
              },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");

        expect((yield* workflow.createDefinition(projectId, definition)).revision).toBe(1);
        const first = yield* workflow.copyForFeature("feature-one", projectId, definition.id);
        expect(first.definition.revision).toBe(1);
        const revised: WorkflowDefinition = { ...definition, name: "Delivery 2", revision: 2 };
        yield* workflow.reviseDefinition(projectId, revised, 1);
        expect(
          (yield* workflow.reviseDefinition(projectId, revised, 1).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* workflow.copyForFeature("feature-one", projectId, definition.id)).definition,
        ).toEqual(definition);
        expect(
          (yield* workflow.copyForFeature("feature-two", projectId, definition.id)).definition,
        ).toEqual(revised);

        const template = yield* botService.getTemplate(templateId);
        if (template === null) throw new Error("Starter template was not created");
        const planner = yield* botService.createDefinition({
          id: "feature-one-planner",
          projectId,
          featureId: "feature-one",
          templateId,
          name: template.name,
          instructions: template.instructions,
          allowedTools: template.allowedTools,
          modelSelection: template.modelSelection,
          runtimeMode: template.runtimeMode,
        });
        const managerRun = yield* botService.createRun({
          id: "manager-run",
          botId: `bot-manager:${projectId}`,
          projectId,
          taskText: "Supervise feature one",
        });
        const plannerRun = yield* botService.createRun({
          id: "run-plan-1",
          botId: planner.id,
          projectId,
          taskText: "Plan feature one",
        });

        const premature = yield* workflow
          .recordTrustedEvent(
            "feature-one",
            stepEvent("complete-too-early", "completed", {
              sourceKind: "handoff",
              sourceId: "handoff-1",
            }),
          )
          .pipe(Effect.result);
        expect(premature._tag).toBe("Failure");
        const start = stepEvent("start-plan", "started", {
          executionId: "execution-1",
          botRunId: "run-plan-1",
          sourceKind: "handoff",
          sourceId: "handoff-1",
        });
        const wrongFeatureRun = yield* workflow
          .recordTrustedEvent("feature-two", start)
          .pipe(Effect.result);
        expect(wrongFeatureRun._tag).toBe("Failure");
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* handoffs.insert({
          id: "handoff-1",
          parentId: null,
          sourceRunId: managerRun.id,
          targetBotId: planner.id,
          targetRunId: plannerRun.id,
          projectId,
          taskText: "Plan feature one",
          contextText: "",
          depth: 1,
          status: "running",
          responseText: null,
          questionText: null,
          lastError: null,
          notificationState: "none",
          noticeVersion: 0,
          attempt: 1,
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        });
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start)).steps.get("plan")?.status,
        ).toBe("running");
        yield* handoffs.transition(
          "handoff-1",
          ["running"],
          "needs-input",
          "2026-09-29T00:00:00.250Z",
          { questionText: "Which API?" },
        );
        yield* workflow.recordTrustedEvent(
          "feature-one",
          stepEvent("question-plan", "question", {
            executionId: "execution-1",
            detail: "Which API?",
            sourceKind: "handoff",
            sourceId: "handoff-1",
          }),
        );
        expect((yield* workflow.getFeatureState("feature-one"))?.steps.get("plan")?.status).toBe(
          "needs-input",
        );
        yield* handoffs.transition(
          "handoff-1",
          ["needs-input"],
          "running",
          "2026-09-29T00:00:00.500Z",
          { responseText: "Use the current API" },
        );
        yield* workflow.recordTrustedEvent(
          "feature-one",
          stepEvent("answer-plan", "answered", {
            executionId: "execution-1",
            detail: "Use the current API",
            sourceKind: "handoff",
            sourceId: "handoff-1",
          }),
        );
        const completion = stepEvent("complete-plan", "completed", {
          executionId: "execution-1",
          outcome: "ready",
          detail: "Plan ready",
          sourceKind: "handoff",
          sourceId: "handoff-1",
        });
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", completion).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", completion).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* handoffs.insert({
          ...(yield* handoffs.get("handoff-1"))!,
          id: "unrelated-handoff",
          targetRunId: "different-run",
          status: "completed",
          responseText: "Different task finished",
        });
        expect(
          (yield* workflow
            .recordTrustedEvent("feature-one", {
              ...completion,
              id: "unrelated-completion",
              sourceId: "unrelated-handoff",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* handoffs.transition(
          "handoff-1",
          ["running"],
          "completed",
          "2026-09-29T00:00:01.000Z",
          { responseText: '{"outcome":"ready","summary":"Plan ready"}' },
        );
        expect(
          (yield* workflow
            .recordTrustedEvent("feature-one", {
              ...completion,
              id: "mismatched-summary",
              detail: "Another result",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* workflow.recordTrustedEvent("feature-one", completion);
        expect((yield* workflow.getFeatureState("feature-one"))?.completed).toBe(true);
        const snapshot = yield* workflow.getFeatureSnapshot("feature-one", projectId);
        expect(snapshot).toMatchObject({
          featureId: "feature-one",
          eventVersion: 4,
          historyLength: 4,
          completed: true,
          activeStepId: null,
        });
        expect(snapshot?.recentEvents.map((item) => item.id)).toEqual([
          "start-plan",
          "question-plan",
          "answer-plan",
          "complete-plan",
        ]);
        expect(snapshot?.steps.find((step) => step.id === "plan")?.threadId).toBe(
          plannerRun.threadId,
        );
        expect(
          (yield* workflow.getFeatureSnapshot("feature-one", otherProjectId).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* workflow.recordTrustedEvent("feature-one", start)).steps.get("plan")?.status,
        ).toBe("completed");
        const reusedId = yield* workflow
          .recordTrustedEvent("feature-one", { ...start, actorId: "another-manager" })
          .pipe(Effect.result);
        expect(reusedId._tag).toBe("Failure");

        yield* workflow.copyForFeature("feature-retry", projectId, definition.id);
        const retryBot = yield* botService.createDefinition({
          id: "feature-retry-planner",
          projectId,
          featureId: "feature-retry",
          templateId,
          name: template.name,
          instructions: template.instructions,
          allowedTools: template.allowedTools,
          modelSelection: template.modelSelection,
          runtimeMode: template.runtimeMode,
        });
        const firstAttempt = yield* botService.createRun({
          id: "retry-run-1",
          botId: retryBot.id,
          projectId,
          taskText: "Plan retry feature",
        });
        yield* handoffs.insert({
          ...(yield* handoffs.get("handoff-1"))!,
          id: "handoff-retry",
          targetBotId: retryBot.id,
          targetRunId: firstAttempt.id,
          status: "running",
          responseText: null,
          questionText: null,
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-start-1", "started", {
            executionId: "retry-execution",
            botRunId: firstAttempt.id,
            sourceKind: "handoff",
            sourceId: "handoff-retry",
          }),
        );
        yield* handoffs.transition("handoff-retry", ["running"], "failed", "2026-09-29T00:00:02Z", {
          lastError: "Provider unavailable",
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-failed-1", "failed", {
            executionId: "retry-execution",
            sourceKind: "handoff",
            sourceId: "handoff-retry",
            detail: "Provider unavailable",
          }),
        );
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-decision", "retry", { executionId: "retry-execution" }),
        );
        expect(yield* handoffs.retry("handoff-retry", "2026-09-29T00:00:03Z")).toBe(true);
        const secondHandoff = (yield* handoffs.get("handoff-retry"))!;
        const secondAttempt = yield* botService.createRun({
          id: secondHandoff.targetRunId,
          botId: retryBot.id,
          projectId,
          taskText: "Plan retry feature",
        });
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-start-2", "started", {
            executionId: "retry-execution",
            botRunId: secondAttempt.id,
            sourceKind: "handoff",
            sourceId: "handoff-retry",
          }),
        );
        expect((yield* workflow.getFeatureState("feature-retry"))?.steps.get("plan")).toMatchObject(
          {
            attempt: 2,
            botRunId: secondAttempt.id,
            status: "running",
          },
        );
        yield* workflow.recordTrustedEvent(
          "feature-retry",
          stepEvent("retry-cancel", "cancelled", { executionId: "retry-execution" }),
        );
        expect((yield* workflow.getFeatureState("feature-retry"))?.cancelled).toBe(true);

        yield* botService.updateTemplate({
          ...template,
          expectedRevision: template.revision,
          enabled: false,
        });
        expect(
          (yield* workflow.copyForFeature("feature-one", projectId, definition.id)).definition,
        ).toEqual(definition);
        const disabledTemplate = yield* workflow
          .copyForFeature("feature-three", projectId, definition.id)
          .pipe(Effect.result);
        expect(disabledTemplate._tag).toBe("Failure");

        const wrongProject = yield* workflow
          .createDefinition(otherProjectId, definition)
          .pipe(Effect.result);
        expect(wrongProject._tag).toBe("Failure");
        const duplicateFeature = yield* workflow
          .copyForFeature("feature-one", otherProjectId, definition.id)
          .pipe(Effect.result);
        expect(duplicateFeature._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
      const afterRestart = Effect.gen(function* () {
        const store = yield* WorkflowStore;
        expect((yield* store.getFeatureCopy("feature-one"))?.definition).toEqual(definition);
        expect((yield* store.getFeatureCopy("feature-two"))?.definition.revision).toBe(2);
        expect((yield* store.listEvents("feature-one")).map((event) => event.kind)).toEqual([
          "started",
          "question",
          "answered",
          "completed",
        ]);
        expect((yield* store.listEvents("feature-retry")).map((event) => event.kind)).toEqual([
          "started",
          "failed",
          "retry",
          "started",
          "cancelled",
        ]);
      }).pipe(
        Effect.provide(
          WorkflowStoreLive.pipe(
            Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* exercise;
        yield* afterRestart;
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
